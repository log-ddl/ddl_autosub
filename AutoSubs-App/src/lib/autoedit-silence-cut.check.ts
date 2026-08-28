// Frame-math checks for the silence cut. Run with:
//   npx esbuild src/lib/autoedit-silence-cut.check.ts --bundle --platform=node \
//     --outfile=<tmp>.mjs --format=esm && node <tmp>.mjs
//
// These cover the parts that are easy to get subtly wrong and impossible to
// eyeball in Resolve: where each kept piece lands after compaction, and whether
// picture and sound land on the *same* frames.

import { compactRanges, sliceClipToKeepSegments } from './autoedit-silence-cut';
import type { TimelineClipInfo } from '@/api/resolve-api';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
  }
}

function clip(
  trackType: 'video' | 'audio',
  recIn: number,
  recOut: number,
  srcStart = 1000,
  track = 1,
): TimelineClipInfo {
  return {
    track,
    track_type: trackType,
    name: `${trackType} clip`,
    record_in_frame: recIn,
    record_out_frame: recOut,
    source_start_frame: srcStart,
    source_end_frame: srcStart + (recOut - recIn),
    left_offset: 0,
    media_pool_ref: { __resolve_obj: 1 },
  } as TimelineClipInfo;
}

console.log('compactRanges');
{
  // Two kept ranges with a 50-frame silence between them: the second should
  // slide left so it starts exactly where the first ended.
  const out = compactRanges([
    { inF: 0, outF: 100 },
    { inF: 150, outF: 250 },
  ]);
  check('second range slides onto the end of the first', out.map((r) => r.compactedInF), [0, 100]);
}
{
  // Out of order and empty ranges must not disturb the layout.
  const out = compactRanges([
    { inF: 150, outF: 250 },
    { inF: 90, outF: 90 },
    { inF: 0, outF: 100 },
  ]);
  check('sorted before compacting', out.map((r) => [r.inF, r.compactedInF]), [[0, 0], [150, 100]]);
  check('zero-length range dropped', out.length, 2);
}

console.log('sliceClipToKeepSegments');
{
  const ranges = compactRanges([
    { inF: 0, outF: 100 },
    { inF: 150, outF: 250 },
  ]);
  const segs = sliceClipToKeepSegments(clip('video', 0, 300, 1000), ranges);
  check('one segment per keep range', segs.length, 2);
  check('landed at compacted positions', segs.map((s) => s.record_in_frame), [0, 100]);
  check('source frames follow the original media', segs.map((s) => [s.source_in_frame, s.source_out_frame]), [[1000, 1100], [1150, 1250]]);
}
{
  // The reason video and audio share one set of ranges: they must compact to
  // identical record frames or the cut drifts out of sync.
  const ranges = compactRanges([
    { inF: 20, outF: 60 },
    { inF: 200, outF: 260 },
  ]);
  const v = sliceClipToKeepSegments(clip('video', 0, 400, 500), ranges);
  const a = sliceClipToKeepSegments(clip('audio', 0, 400, 900), ranges);
  check('picture and sound land on the same frames', v.map((s) => s.record_in_frame), a.map((s) => s.record_in_frame));
}
{
  // A keep range that only partly overlaps the clip must be clipped to it.
  const ranges = compactRanges([{ inF: 50, outF: 250 }]);
  const segs = sliceClipToKeepSegments(clip('video', 100, 200, 1000), ranges);
  check('range trimmed to the clip bounds', segs.map((s) => [s.source_in_frame, s.source_out_frame]), [[1000, 1100]]);
  check('offset within the range preserved', segs[0].record_in_frame, 50);
}
{
  // Retimed / conformed media: 2 source frames per record frame.
  const retimed = clip('video', 0, 100, 1000);
  retimed.source_end_frame = 1200; // 200 source frames over 100 record frames
  const segs = sliceClipToKeepSegments(retimed, compactRanges([{ inF: 10, outF: 60 }]));
  check('source range scales by the clip ratio', segs.map((s) => [s.source_in_frame, s.source_out_frame]), [[1020, 1120]]);
}
{
  const segs = sliceClipToKeepSegments(clip('video', 500, 600), compactRanges([{ inF: 0, outF: 100 }]));
  check('clip outside every range yields nothing', segs.length, 0);
}

console.log('cutting several tracks at once');
{
  const ranges = compactRanges([
    { inF: 0, outF: 100 },
    { inF: 150, outF: 250 },
  ]);
  const v1 = sliceClipToKeepSegments(clip('video', 0, 300, 1000, 1), ranges);
  const v2 = sliceClipToKeepSegments(clip('video', 0, 300, 5000, 2), ranges);
  const a3 = sliceClipToKeepSegments(clip('audio', 0, 300, 9000, 3), ranges);

  // Without this every video segment would land on one track, flattening the
  // layering into a single track.
  check('each segment names its own track', [v1[0].track_index, v2[0].track_index, a3[0].track_index], [1, 2, 3]);
  check('V2 keeps its own source media', v2.map((s) => s.source_in_frame), [5000, 5150]);
  check('all tracks compact to the same frames', [v1, v2, a3].map((segs) => segs.map((s) => s.record_in_frame)), [[0, 100], [0, 100], [0, 100]]);
}

console.log('in-place cut with In/Out (ranges built the way applySilenceCut does)');
{
  // Timeline 0..1000. Marks at 300..700. Speech inside the marks: 320..400 and
  // 500..650. Everything outside the marks must survive and ripple left.
  const speech = [
    { inF: 320, outF: 400 },
    { inF: 500, outF: 650 },
  ];
  const markInF = 300;
  const markOutF = 700;
  const trackEndF = 1000;
  const ranges = [...speech, { inF: 0, outF: markInF }, { inF: markOutF, outF: trackEndF }];
  const keep = compactRanges(ranges);

  check('head, both speech spans and tail all kept', keep.map((r) => [r.inF, r.outF]), [[0, 300], [320, 400], [500, 650], [700, 1000]]);
  check('laid end to end with no gaps', keep.map((r) => r.compactedInF), [0, 300, 380, 530]);

  const removed = (markOutF - markInF) - (80 + 150);
  const newLength = keep.reduce((a, r) => a + (r.outF - r.inF), 0);
  check('timeline shortened by exactly the silence removed', 1000 - newLength, removed);

  // The tail must keep its full length, just start earlier.
  const tail = keep[keep.length - 1];
  check('tail keeps its duration', tail.outF - tail.inF, 300);
  check('tail rippled left by the removed amount', tail.inF - tail.compactedInF, removed);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
