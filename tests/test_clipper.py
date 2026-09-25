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


class Formats(unittest.TestCase):
    ch = {"name": "x", "style": {"accent": "#fff"}, "defaultFormat": "short",
          "formats": {"short": {"maxSeconds": 59}, "long": {"maxSeconds": 1800}}}

    def test_format_merges_defaults_style_and_format(self):
        name, st = clipper.format_style(self.ch, "long")
        self.assertEqual(name, "long")
        self.assertEqual((st["layout"], st["captionMode"], st["maxSeconds"], st["accent"]), ("wide", "lines", 1800, "#fff"))
        self.assertEqual(clipper.format_style(self.ch, None)[0], "short")
        with self.assertRaises(SystemExit):
            clipper.format_style(self.ch, "podcast")

    def test_old_configs_are_one_short_format(self):
        name, st = clipper.format_style({"name": "x", "style": {"layout": "fill"}}, None)
        self.assertEqual((name, st["layout"]), ("short", "fill"))


class Chapters(unittest.TestCase):
    def test_valid(self):
        out = clipper.parse_chapters("0:00 Intro; 2:15 The mistake; 7:40 The fix", 600)
        self.assertEqual(out.splitlines(), ["Chapters:", "0:00 Intro", "2:15 The mistake", "7:40 The fix"])

    def test_youtube_rules(self):
        for bad in ("0:05 A; 1:00 B; 2:00 C", "0:00 A; 1:00 B", "0:00 A; 0:05 B; 2:00 C"):
            with self.assertRaises(SystemExit):
                clipper.parse_chapters(bad, 600)


class CreatorRights(unittest.TestCase):
    def test_object_entries_and_permission_note(self):
        ch = {"name": "x", "rights": "permission",
              "allowedCreators": [{"handle": "@Friend", "permission": "clip program"}]}
        self.assertEqual(clipper.check_rights(ch, "Friend", "@friend", False)["permission"], "clip program")

    def test_permission_channel_with_no_creators_refuses(self):
        with self.assertRaises(SystemExit):
            clipper.check_rights({"name": "x", "rights": "permission"}, "Anyone", "@anyone", False)

    def test_licensed_needs_creative_commons(self):
        ch = {"name": "x", "rights": "licensed"}
        clipper.check_rights(ch, "A", "@a", False, license_="Creative Commons Attribution license (reuse allowed)")
        with self.assertRaises(SystemExit):
            clipper.check_rights(ch, "A", "@a", False, license_="")
