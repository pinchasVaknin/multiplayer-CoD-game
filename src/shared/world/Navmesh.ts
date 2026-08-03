/**
 * The navmesh, in two files.
 *
 * `NavGrid.ts` is the structure and its queries; `NavBake.ts` is the bake that fills it out
 * of collision geometry. This barrel is what the rest of the project imports, so the split
 * (forced by the layered grid M4 needed and S3's file-size guidance) is invisible to every
 * consumer that was already importing from `world/Navmesh`.
 */
export * from './NavGrid';
export * from './NavBake';
