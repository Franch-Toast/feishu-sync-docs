import { randomUUID } from "node:crypto";
import { splitDocument, writeSyncDocument } from "./frontmatter.js";
import type { SyncServices } from "./sync_services.js";
import type { EntryBinding, LocalFile, RemoteTree, SyncRoot } from "./types.js";

/**
 * Frontmatter ↔ bindings.json identity index and arbitration.
 *
 * `index()` reads every local markdown file's envelope and answers "which
 * local path claims which remote token". `reconcile()` then arbitrates each
 * claim against the path-keyed binding in `bindings.json` and the remote tree
 * with a fixed matrix, so the two identity stores can never drift silently:
 *
 * | # | file token | binding(path) | token on remote | action                              |
 * |---|-----------|---------------|-----------------|-------------------------------------|
 * | 1 | T         | T             | yes             | steady; add a missing `feishu_root` |
 * | 2 | none      | T             | yes             | back-fill the envelope (self-heal)  |
 * | 3 | T         | T'            | yes             | file wins: re-key T's binding here  |
 * | 4 | T         | T'            | no              | keep the DB token, raise conflict   |
 * | 5 | T         | none (T at P')| yes             | moved: migrate binding P' → P       |
 * | 6 | T         | none, T also claimed by another file | — | conflict on both, never auto-resolved |
 *
 * Two iron rules the matrix enforces structurally:
 * - R1: a file carrying a `feishu_token` is never re-bound by heuristics
 *   (title / content hash); the caller must exclude claimed paths from the
 *   fuzzy pairing tiers (`sync.ts` does).
 * - R2: one token belongs to exactly one path; any multi-claim escalates to a
 *   human-visible `kind: "identity"` conflict instead of a guess.
 */

/** A token may be claimed by at most one path; ambiguous claims stay in
 *  `claims` only, so pairing code can never pick one up by accident. */
export interface TokenIndex {
  /** token → relative path, unambiguous claims only. */
  byToken: Map<string, string>;
  /** token → every path that declared it (length > 1 breaks R2). */
  claims: Map<string, string[]>;
  /** path → token of a `feishu_root` that is not this root: the file came
   *  from another account/tree and must not pair with anything here. */
  foreign: Map<string, string>;
  /** Document paths with no usable token (plain, unstamped files). */
  missing: string[];
  /** Document paths whose envelope is malformed; never rewritten. */
  malformed: string[];
  /** path → rootId a valid envelope declared (used to fill in `feishu_root`). */
  tokens: Map<string, { token: string; rootId?: string }>;
}

export interface IdentityDrift {
  token: string;
  /** Path the binding record still points at. */
  from: string;
  /** Path the file's envelope says is real. */
  to: string;
  /** Token the stale path record carried before the file-side won. */
  lostToken?: string;
}

export interface IdentityReconcileReport {
  /** Matrix #2: envelopes written for bound-but-unstamped files. */
  backfilled: string[];
  /** Matrix #1: envelopes that only gained a missing `feishu_root`. */
  rootCompleted: string[];
  rekeyed: IdentityDrift[];
  /** Paths escalated to an identity conflict (matrix #4 and #6). */
  conflicts: string[];
  /** Paths skipped because their envelope could not be parsed safely. */
  malformed: string[];
  unchanged: number;
}

export class IdentityResolver {
  constructor(private readonly services: SyncServices) {}

  /** Build the token index over all local markdown documents. Accepts the
   *  caller's fresh scan so a sync round never walks the tree twice. */
  async index(root: SyncRoot, files?: LocalFile[]): Promise<TokenIndex> {
    const list = (files ?? (await this.services.local.scan(root))).filter((file) => file.kind === "document");
    const index: TokenIndex = { byToken: new Map(), claims: new Map(), foreign: new Map(), missing: [], malformed: [], tokens: new Map() };
    for (const file of list) {
      const raw = await this.services.local.readText(root, file.relativePath);
      const split = splitDocument(raw);
      if (split.malformed) {
        index.malformed.push(file.relativePath);
        continue;
      }
      if (!split.token) {
        index.missing.push(file.relativePath);
        continue;
      }
      if (split.rootId && split.rootId !== root.id && split.rootId !== root.remoteToken) {
        index.foreign.set(file.relativePath, split.rootId);
        continue;
      }
      index.tokens.set(file.relativePath, { token: split.token, ...(split.rootId ? { rootId: split.rootId } : {}) });
      const bucket = index.claims.get(split.token);
      if (bucket) bucket.push(file.relativePath);
      else index.claims.set(split.token, [file.relativePath]);
    }
    for (const [token, paths] of index.claims) {
      if (paths.length === 1) index.byToken.set(token, paths[0]!);
    }
    return index;
  }

  /** Apply the arbitration matrix to every claim. Binding writes happen here
   *  so the pairing tiers downstream only ever see an already-consistent
   *  (path → token) set. `tree` may be supplied to avoid a second drive
   *  listing during a scan round. */
  async reconcile(root: SyncRoot, index: TokenIndex, tree?: RemoteTree): Promise<IdentityReconcileReport> {
    const { local, metaStorage, remote } = this.services;
    const report: IdentityReconcileReport = { backfilled: [], rootCompleted: [], rekeyed: [], conflicts: [], malformed: index.malformed, unchanged: 0 };
    const remoteTokens = tree
      ? new Set(tree.nodes.map((node) => node.token))
      : new Set((await remote.listTree(root)).nodes.map((node) => node.token));

    // R2 first: multi-claim tokens are never arbitrated automatically.
    const contested = new Set<string>();
    for (const [token, paths] of index.claims) {
      if (paths.length < 2) continue;
      contested.add(token);
      for (const path of paths) {
        await this.raiseIdentityConflict(root, path, token, `token ${token} is claimed by ${paths.join(", ")}`);
        report.conflicts.push(path);
      }
    }

    // Matrix #2: bound but unstamped files self-heal their envelope. This is
    // also the crash-recovery path: a binding saved after a create/pull whose
    // stamp never landed gets back-filled before anything reads the file.
    for (const path of index.missing) {
      if (index.malformed.includes(path)) continue;
      const binding = await metaStorage.getBinding(root.id, path);
      if (!binding?.remoteToken || binding.kind !== "document") continue;
      if (!remoteTokens.has(binding.remoteToken)) continue;
      const stamped = await this.stamp(root, path, { token: binding.remoteToken, rootId: root.id });
      if (stamped) report.backfilled.push(path);
    }

    for (const [path, claim] of index.tokens) {
      if (contested.has(claim.token)) continue;
      const bindingAtPath = await metaStorage.getBinding(root.id, path);
      const bindingByToken = await metaStorage.findBindingByToken(root.id, claim.token);
      const onRemote = remoteTokens.has(claim.token);

      if (bindingAtPath?.remoteToken === claim.token) {
        // Matrix #1: steady state; only a missing `feishu_root` is added.
        if (!claim.rootId) {
          const stamped = await this.stamp(root, path, { token: claim.token, rootId: root.id });
          if (stamped) report.rootCompleted.push(path);
        } else report.unchanged += 1;
        continue;
      }

      if (bindingAtPath && bindingAtPath.remoteToken && bindingAtPath.remoteToken !== claim.token) {
        if (onRemote && bindingByToken) {
          // Matrix #3: the file side wins — re-key T's binding record (wherever
          // it lives) to this path and surface the drift for audit.
          const from = bindingByToken.relativePath;
          if (from !== path) {
            await metaStorage.deleteBinding(root.id, from);
            await metaStorage.setBinding(root.id, path, this.migrate(bindingByToken, path));
          }
          report.rekeyed.push({ token: claim.token, from, to: path, ...(bindingAtPath.remoteToken ? { lostToken: bindingAtPath.remoteToken } : {}) });
          continue;
        }
        // Matrix #4: the envelope names a token the drive does not have while
        // the DB says T'. Never overwrite or delete the user's id — freeze the
        // pair as a conflict for a human to untangle.
        await this.raiseIdentityConflict(root, path, claim.token, `frontmatter token ${claim.token} is not on the remote; binding keeps ${bindingAtPath.remoteToken}`);
        report.conflicts.push(path);
        continue;
      }

      if (!bindingAtPath || !bindingAtPath.remoteToken) {
        if (!onRemote) {
          // A token the drive does not know and no binding claims: leave it
          // exactly as it is (R1 forbids heuristic re-binding; the remote may
          // simply be offline this round).
          report.unchanged += 1;
          continue;
        }
        if (bindingByToken && bindingByToken.relativePath !== path) {
          // Matrix #5: local rename/move — migrate the binding to the path the
          // envelope now reports.
          const from = bindingByToken.relativePath;
          await metaStorage.deleteBinding(root.id, from);
          await metaStorage.setBinding(root.id, path, this.migrate(bindingByToken, path));
          report.rekeyed.push({ token: claim.token, from, to: path });
          continue;
        }
        if (!bindingByToken) {
          // Token known on the remote but no binding record exists at all
          // (e.g. `.feishu-sync` deleted): claim it for this path so Tier-0
          // pairing picks the pair up without any heuristics.
          await metaStorage.setBinding(root.id, path, {
            entryId: bindingAtPath?.entryId ?? randomUUID(),
            rootId: root.id,
            relativePath: path,
            kind: "document",
            remoteToken: claim.token,
            status: "pending",
            identitySource: "frontmatter",
            updatedAt: new Date().toISOString()
          });
          report.rekeyed.push({ token: claim.token, from: "", to: path });
          continue;
        }
        report.unchanged += 1;
        continue;
      }
      report.unchanged += 1;
    }
    return report;
  }

  /** Re-key one binding record onto a new path, keeping its remote identity,
   *  entry id and last-synced commit so the pair stays clean. */
  private migrate(binding: EntryBinding, relativePath: string): EntryBinding {
    return {
      ...binding,
      relativePath,
      kind: "document",
      status: binding.status === "conflict" ? "conflict" : binding.status,
      identitySource: "frontmatter",
      updatedAt: new Date().toISOString()
    };
  }

  /** Rewrite a file's envelope; returns false when the stamp was refused
   *  (malformed block) so callers can count real back-fills only. */
  private async stamp(root: SyncRoot, relativePath: string, id: { token: string; rootId?: string }): Promise<boolean> {
    const { local } = this.services;
    const raw = await local.readText(root, relativePath);
    const result = writeSyncDocument(raw, id);
    // Refused (malformed) or already correct: no write, nothing counted.
    if (result.warning || !result.changed) return false;
    await local.writeText(root, relativePath, result.text);
    return true;
  }

  /** Freeze a path as an identity conflict: entry status flips to `conflict`
   *  and an open `kind: "identity"` record explains what collided. */
  private async raiseIdentityConflict(root: SyncRoot, relativePath: string, token: string, reason: string): Promise<void> {
    const { local, metaStorage } = this.services;
    const binding = await metaStorage.getBinding(root.id, relativePath);
    const entryId = binding?.entryId ?? randomUUID();
    await metaStorage.setBinding(root.id, relativePath, {
      ...(binding ?? {
        entryId,
        rootId: root.id,
        relativePath,
        kind: "document" as const,
        status: "conflict" as const,
        updatedAt: new Date().toISOString()
      }),
      entryId,
      status: "conflict",
      updatedAt: new Date().toISOString()
    });
    const open = (await metaStorage.listConflicts("open")).find((conflict) => conflict.entryId === entryId && conflict.kind === "identity");
    let content = "";
    try {
      content = await local.readText(root, relativePath);
    } catch { /* the file may be mid-deletion; the reason still stands */ }
    if (open) await metaStorage.updateConflict(open.id, { localContent: content });
    else await metaStorage.createConflict({ entryId, baseContent: "", localContent: content, remoteContent: `${token}: ${reason}`, kind: "identity" });
  }
}
