import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import clipper  # noqa: E402


class Times(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(clipper.parse_time("83.5"), 83.5)
        self.assertEqual(clipper.parse_time("1:23"), 83)
        self.assertEqual(clipper.parse_time("1:02:03"), 3723)
        with self.assertRaises(SystemExit):
            clipper.parse_time("1:xx")


class Transcripts(unittest.TestCase):
    def test_json3_word_offsets(self):
        data = {"events": [{"tStartMs": 1000, "dDurationMs": 2000, "segs": [
            {"utf8": "fresh"}, {"utf8": " air", "tOffsetMs": 400}, {"utf8": " works", "tOffsetMs": 900}]}]}
        words = clipper.words_from_json3(data)
        self.assertEqual([w["w"] for w in words], ["fresh", "air", "works"])
        self.assertEqual([w["t"] for w in words], [1.0, 1.4, 1.9])
        self.assertTrue(all(w["e"] > w["t"] for w in words))

    def test_vtt_rolling_duplicates(self):
        vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello there\n\n00:00:02.000 --> 00:00:03.000\nhello there friend\n"
        with tempfile.NamedTemporaryFile("w", suffix=".vtt", delete=False) as f:
            f.write(vtt)
        cues = clipper.parse_cue_file(Path(f.name))
        self.assertEqual([c[2] for c in cues], ["hello there", "friend"])

    def test_lines_break_on_sentences(self):
        words = clipper.words_from_cues([(0, 2, "One sentence. Another one")])
        self.assertEqual([l["text"] for l in clipper.transcript_lines(words)], ["One sentence.", "Another one"])


class Rights(unittest.TestCase):
    def test_requires_rights_field(self):
        with self.assertRaises(SystemExit):
            clipper.check_rights({"name": "x"}, "Someone", "@someone", False)

    def test_allowed_creators(self):
        ch = {"name": "x", "rights": "permission", "allowedCreators": ["@Friend"]}
        clipper.check_rights(ch, "Friend Name", "@friend", False)  # matches, case-insensitive
        with self.assertRaises(SystemExit):
            clipper.check_rights(ch, "Stranger", "@stranger", False)
        clipper.check_rights(ch, "Stranger", "@stranger", True)  # explicit override


class Captions(unittest.TestCase):
    def test_ass_highlights_one_word_at_a_time(self):
        words = clipper.words_from_cues([(10, 12, "fresh air works")])
        ass = clipper.build_ass(words, 10, 12, "Pins stalled?", {"accent": "#8BE04E"}, 1080, 1920)
        caps = [l for l in ass.splitlines() if l.startswith("Dialogue: 0")]
        self.assertEqual(len(caps), 3)
        self.assertIn("{\\c&H004EE08B&}FRESH", caps[0])
        self.assertIn("Pins stalled?", ass)


if __name__ == "__main__":
    unittest.main()
