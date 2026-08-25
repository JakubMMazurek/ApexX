/**
 * Position mapping for the ApexX lowering pipeline.
 *
 * Every stage rewrites text as a set of non-overlapping splices, so each stage can
 * report exactly which output span came from which input span. Chaining the stage
 * maps gives an exact offset mapping between the authored `.clsx` and the generated
 * `.cls`, which is what lets a plain-Apex language server answer questions about
 * generated code and have the answers reported against the original source.
 */

export interface Splice {
  start: number;
  end: number;
  replacement: string;
}

export interface MappedRegion {
  outStart: number;
  outEnd: number;
  srcStart: number;
  srcEnd: number;
  /** True when the text was copied through unchanged, so offsets shift by a constant. */
  verbatim: boolean;
}

export interface PositionMap {
  regions: MappedRegion[];
}

export interface ChainedPositionMap {
  /** Maps an offset in the final output back to the original source. */
  toSource(outputOffset: number): number | undefined;
  /** Maps an offset in the original source to the final output. */
  toOutput(sourceOffset: number): number | undefined;
  /** True when the offset lands in text that was copied through unchanged. */
  isVerbatim(outputOffset: number): boolean;
}

/**
 * Applies splices in the same order and with the same overlap rule the pipeline
 * already used, and records the resulting regions.
 */
export function applySplices(
  source: string,
  splices: Splice[],
): { output: string; map: PositionMap } {
  const regions: MappedRegion[] = [];
  const ordered = [...splices].sort((left, right) => left.start - right.start);
  let output = "";
  let cursor = 0;

  const pushVerbatim = (from: number, to: number): void => {
    if (to <= from) {
      return;
    }

    regions.push({
      outStart: output.length,
      outEnd: output.length + (to - from),
      srcStart: from,
      srcEnd: to,
      verbatim: true,
    });
    output += source.slice(from, to);
  };

  for (const splice of ordered) {
    if (splice.start < cursor) {
      continue;
    }

    pushVerbatim(cursor, splice.start);

    regions.push({
      outStart: output.length,
      outEnd: output.length + splice.replacement.length,
      srcStart: splice.start,
      srcEnd: splice.end,
      verbatim: false,
    });
    output += splice.replacement;
    cursor = splice.end;
  }

  pushVerbatim(cursor, source.length);

  return { output, map: { regions } };
}

/** A map for a stage that left the text untouched. */
export function identityMap(length: number): PositionMap {
  return {
    regions: [
      { outStart: 0, outEnd: length, srcStart: 0, srcEnd: length, verbatim: true },
    ],
  };
}

/** Chains stage maps given in pipeline order, source first. */
export function chainMaps(maps: PositionMap[]): ChainedPositionMap {
  const stageToSource = (map: PositionMap, offset: number): number | undefined => {
    const region = map.regions.find(
      candidate => offset >= candidate.outStart && offset < candidate.outEnd,
    );

    if (!region) {
      // The very end of the output maps to the very end of the input.
      const last = map.regions.at(-1);
      return last && offset >= last.outEnd ? last.srcEnd : undefined;
    }

    return region.verbatim
      ? region.srcStart + (offset - region.outStart)
      : region.srcStart;
  };

  const stageToOutput = (map: PositionMap, offset: number): number | undefined => {
    const region = map.regions.find(
      candidate => offset >= candidate.srcStart && offset < candidate.srcEnd,
    );

    if (!region) {
      const last = map.regions.at(-1);
      return last && offset >= last.srcEnd ? last.outEnd : undefined;
    }

    return region.verbatim
      ? region.outStart + (offset - region.srcStart)
      : region.outStart;
  };

  const verbatimAt = (map: PositionMap, offset: number): boolean =>
    map.regions.find(
      candidate => offset >= candidate.outStart && offset < candidate.outEnd,
    )?.verbatim ?? false;

  return {
    toSource(outputOffset) {
      let offset: number | undefined = outputOffset;

      for (const map of [...maps].reverse()) {
        if (offset === undefined) {
          return undefined;
        }

        offset = stageToSource(map, offset);
      }

      return offset;
    },

    toOutput(sourceOffset) {
      let offset: number | undefined = sourceOffset;

      for (const map of maps) {
        if (offset === undefined) {
          return undefined;
        }

        offset = stageToOutput(map, offset);
      }

      return offset;
    },

    isVerbatim(outputOffset) {
      let offset: number | undefined = outputOffset;

      for (const map of [...maps].reverse()) {
        if (offset === undefined) {
          return false;
        }

        if (!verbatimAt(map, offset)) {
          return false;
        }

        offset = stageToSource(map, offset);
      }

      return offset !== undefined;
    },
  };
}

/** Builds splices from a global regex replace so the stage can report positions. */
export function splicesFromReplace(
  source: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => string | undefined,
): Splice[] {
  const splices: Splice[] = [];
  const scanner = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;

  while ((match = scanner.exec(source)) !== null) {
    const replacement = replacer(match);

    if (replacement !== undefined && replacement !== match[0]) {
      splices.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement,
      });
    }

    if (match[0].length === 0) {
      scanner.lastIndex += 1;
    }
  }

  return splices;
}

/**
 * Refines a block-level mapping down to a token.
 *
 * An offset inside a rewritten span maps only to the start of that span, because
 * the span as a whole was replaced. The replacement usually still contains the
 * authored expression verbatim, though, so the identifier at the authored offset
 * is located within the generated text and the nearest occurrence to the block is
 * used. Returns undefined when the identifier does not survive lowering.
 */
export function mapIdentifierOffset(
  map: ChainedPositionMap,
  source: string,
  output: string,
  sourceOffset: number,
): number | undefined {
  const blockStart = map.toOutput(sourceOffset);

  if (blockStart === undefined) {
    return undefined;
  }

  if (map.isVerbatim(blockStart)) {
    return blockStart;
  }

  const identifier = identifierAround(source, sourceOffset);

  if (!identifier) {
    return blockStart;
  }

  const pattern = new RegExp(`\\b${identifier.name}\\b`, "g");
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    // Prefer the first occurrence at or after the block start; the authored text
    // is inside this block, so anything earlier belongs to a different one.
    const distance =
      match.index >= blockStart
        ? match.index - blockStart
        : (blockStart - match.index) * 4;

    if (distance < bestDistance) {
      bestDistance = distance;
      best = match.index;
    }
  }

  return best ?? blockStart;
}

function identifierAround(
  source: string,
  offset: number,
): { name: string; start: number } | undefined {
  const before = /[A-Za-z_][A-Za-z0-9_]*$/.exec(source.slice(0, offset))?.[0] ?? "";
  const after = /^[A-Za-z0-9_]*/.exec(source.slice(offset))?.[0] ?? "";
  const name = `${before}${after}`;

  return name.length > 0 && !/^[0-9]/.test(name)
    ? { name, start: offset - before.length }
    : undefined;
}

/**
 * Maps a span from a stage's coordinate space back to the input of the first map.
 *
 * `chainMaps().toSource` answers for a single offset, which is not enough for a
 * range: an offset inside a rewritten span collapses to that span's start, so
 * mapping the end offset that way would produce an empty range. The start and the
 * end are therefore resolved against the regions they each land in, which keeps a
 * span that survived verbatim exact and widens one that was rewritten to cover the
 * whole authored construct.
 *
 * Pass the maps in pipeline order, source first — the same order `chainMaps` takes.
 */
export function spanToSource(
  maps: PositionMap[],
  start: number,
  end: number,
): { start: number; end: number } {
  let span = { start, end: Math.max(end, start) };

  for (const map of [...maps].reverse()) {
    span = stageSpanToSource(map, span.start, span.end);
  }

  return span;
}

function stageSpanToSource(
  map: PositionMap,
  start: number,
  end: number,
): { start: number; end: number } {
  // A zero-length span still has to land somewhere, so it is looked up as if it
  // covered one character.
  const lookupEnd = Math.max(end, start + 1);
  const overlapping = map.regions.filter(
    region => region.outStart < lookupEnd && region.outEnd > start,
  );

  if (overlapping.length === 0) {
    const last = map.regions.at(-1);
    const fallback = last?.srcEnd ?? start;
    return { start: fallback, end: fallback };
  }

  const first = overlapping[0];
  const last = overlapping.at(-1) as MappedRegion;
  const mappedStart = first.verbatim
    ? first.srcStart + Math.max(start - first.outStart, 0)
    : first.srcStart;
  const mappedEnd = last.verbatim
    ? Math.min(last.srcStart + Math.max(end - last.outStart, 0), last.srcEnd)
    : last.srcEnd;

  return { start: mappedStart, end: Math.max(mappedEnd, mappedStart) };
}
