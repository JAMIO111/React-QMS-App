---
title: Formulas in imports
summary: The formula language for import templates and record filters - how to write a formula, every operator and function, and worked examples.
group: Admin and security
order: 49
---
When an import's standard steps can't produce a value, you can write a **formula**. One formula language is used everywhere in imports, whether the records come from a file, an API, a database, a folder or an internal API through the connector agent.

## Where you can write a formula

- **A field in an import template.** In the mapping step, open a field's row and choose **Use a formula instead of a column**. The formula's result fills that Fortress field.
- **A record filter.** In the **Filter records** step, choose **Use a formula instead of rules**. Records for which the formula is true are the ones the filter matches.

Formulas only appear once **advanced imports** are switched on. Someone who can manage the organisation does this in **Settings → Integrations → Advanced imports**. Templates and filters already saved with a formula keep working if it is switched off again. Formulas just can't be added or changed until it is back on.

## How a formula is worked out

A formula is worked out once for every record the import reads.

- It can read only that record's own columns. It cannot look up other records, other files, the internet or anything in Fortress.
- It has no variables, loops or functions of your own, so it always finishes and never changes anything.
- For a field, the result becomes **text**. Any steps you added to the field then run on that text. Last, the field's own checks apply: a date must be a real date, a number must be a number, a choice must be on the list, and a link must find its record.
- For a filter, the record matches when the result is **true**. In practice that means writing a test: `=`, `>`, `IN(…)`, `AND`, `ISEMPTY(…)` and so on.

The editor shows the result for the example record as you type, and it underlines problems such as a misspelt column. **Preview** shows the result for the first rows of the file before anything is written.

## Writing a formula

| You want | Write | Notes |
|---|---|---|
| A column | `[Part number]` | The name exactly as it is in the source: spaces and capitals count. To include a `]` in the name, write it twice: `[Size [mm]]]` reads the column `Size [mm]`. |
| A field an API sends inside another one | `[customer.code]` | API fields are flattened with dots. A list of plain values arrives joined with commas. |
| Text | `"Leeds"` | Always in double quotes. To include a `"`, write it twice: `"6"" pipe"` is `6" pipe`. |
| A number | `42`, `0.5`, `.5`, `1e3` | A full stop is the decimal mark. Don't put thousands separators in a number you type. |
| True or false | `TRUE`, `FALSE` | Any capitals. |
| A function | `UPPER([Name])` | Function names can be in any capitals. Separate the values with commas. |
| Brackets | `([A] + [B]) * 2` | To work out one part first. |

Spaces and new lines between parts are ignored, so you can lay a long formula out over several lines. A formula can be up to 2,000 characters long, with up to 32 levels of brackets and functions inside each other.

## Values

Every value inside a formula is one of these:

- **Empty**: a column with nothing in it (cells are trimmed, so a cell of only spaces is empty too).
- **Text**, such as `"ABC-123"`.
- **A number**, such as `12.5`.
- **True or false.**
- **A date**, which only comes from the date functions.

Values from the source are text until a function reads them as something else. Fortress tries to do what you mean:

- In arithmetic (`+ - * /`), text that looks like a number is used as a number. `"1,250.5"` reads as 1250.5: commas are taken as thousands separators. For a decimal comma, use `NUMBER([Price], ",")`.
- Where a test is expected (`IF`, `AND`, `OR`, `NOT`), `true`, `yes`, `y` and `1` count as true; `false`, `no`, `n`, `0` and empty count as false. Anything else is an error.
- Where a date is expected (`ADDDAYS`, `YEAR`, `MONTH`, `DAY`), the value must already be a date. Read it with `DATE` first, unless the source already writes it as `2026-11-03`.

When the result fills a field, it is turned into text like this:

- Numbers are written plainly, with no thousands separators, rounded to 15 significant figures.
- True and false become `true` and `false`, which a yes/no field accepts.
- Dates become `2026-11-03`. Leave a date field's **Dates written as** setting on year-month-day when its formula returns a date.

### Empty values

An empty value passes quietly through most of a formula, so a gap in the source does not make every row fail:

- Arithmetic with an empty value gives empty: `[Qty] * 2` is empty when Qty is empty.
- `&` and `CONCAT` treat empty as no text at all.
- Number and date functions given an empty value return empty.
- A field whose formula gives empty is left empty, and a required field then rejects the row. The **When empty** setting belongs to a plain column, not to a formula: give the fallback inside the formula with `IFEMPTY` or `COALESCE`, or add a **Default** step after it.

Use `IFEMPTY`, `COALESCE` and `ISEMPTY` when you want to decide what happens yourself.

## Operators

The rows below are listed from the tightest binding to the loosest. For example, `2 + 3 * 4` is 14, because `*` is worked out before `+`, and `[A] & [B] = "XY"` joins first, then compares.

| Operator | Meaning | Example | Result |
|---|---|---|---|
| `-` `+` (before a value) | Negative, positive | `-[Offset]` | Offset with its sign changed |
| `*` `/` | Multiply, divide | `[Length] / 1000` | Length in metres from millimetres |
| `+` `-` | Add, subtract | `[Qty] - [Scrap]` | What is left |
| `&` | Join as text | `[First name] & " " & [Surname]` | `Ada Lovelace` |
| `=` `<>` `<` `<=` `>` `>=` | Compare (`<>` is "not equal") | `[Qty] > 100` | true or false |
| `NOT` | The opposite | `NOT ISEMPTY([Part])` | true when Part has a value |
| `AND` | Both | `[Status] = "Open" AND [Qty] > 0` | true or false |
| `OR` | Either | `[Site] = "LEEDS" OR [Site] = "HULL"` | true or false |

Dividing by zero is an error, and so is a number too large to work with.

### How comparisons work

- **Text is compared ignoring capitals**: `"leeds" = "LEEDS"` is true.
- **When either side is a number you typed**, both sides are compared as numbers if they read as numbers: `[Qty] > 5` works on a column holding `12`.
- **Two columns are compared as text** unless you read them as numbers. `[A] > [B]` with A = `10` and B = `9` is **false**, because the text "10" sorts before "9". Write `NUMBER([A]) > NUMBER([B])` instead.
- Two empty values are equal, and an empty value is less than any text.

## Functions

### Text

| Function | What it gives | Example | Result |
|---|---|---|---|
| `CONCAT(value, value, …)` | The values joined into one text (up to 50) | `CONCAT([Prefix], "-", [Number])` | `PN-0042` |
| `LEFT(text, count)` | The first characters; one when no count is given | `LEFT("ABC-123", 3)` | `ABC` |
| `RIGHT(text, count)` | The last characters; one when no count is given | `RIGHT("ABC-123", 3)` | `123` |
| `MID(text, start, count)` | Characters from a position; the first character is 1 | `MID("ABC-123", 5, 2)` | `12` |
| `LEN(text)` | How many characters | `LEN("ABC-123")` | `7` |
| `UPPER(text)` | In capitals | `UPPER("abc")` | `ABC` |
| `LOWER(text)` | In small letters | `LOWER("ABC")` | `abc` |
| `PROPER(text)` | Each word with a capital | `PROPER("ada LOVELACE")` | `Ada Lovelace` |
| `TRIM(text)` | No spaces at the ends, single spaces inside | `TRIM("  A   B ")` | `A B` |
| `SUBSTITUTE(text, find, with)` | Every "find" replaced by "with", ignoring capitals | `SUBSTITUTE("12-345", "-", "")` | `12345` |
| `FIND(find, text)` | Where "find" first appears (1 is the first character, 0 means it isn't there); ignores capitals | `FIND("-", "ABC-123")` | `4` |
| `SPLIT(text, separator, part)` | One part of the text: 1 is the first, -1 the last, -2 the one before; trimmed; empty when there is no such part | `SPLIT("PO-1/20", "/", -1)` | `20` |

### Logic

| Function | What it gives | Example |
|---|---|---|
| `IF(test, then, else)` | `then` when the test is true, otherwise `else` (empty when no else is given) | `IF([Qty] > 100, "major", "minor")` |
| `IFS(test, value, test, value, …)` | The value after the first true test; empty when none is true. Tests and values come in pairs. | `IFS([Score] >= 90, "A", [Score] >= 75, "B", TRUE, "C")` |
| `SWITCH(value, case, result, case, result, …, otherwise)` | The result for the first case equal to the value (ignoring capitals); the last value, if there is one left over, when none is equal | `SWITCH([Status], "A", "active", "I", "inactive", "active")` |
| `IN(value, option, option, …)` | True when the value equals one of the options (ignoring capitals) | `IN([Site], "LEEDS", "HULL")` |
| `IFEMPTY(value, otherwise)` | The value, or `otherwise` when it is empty | `IFEMPTY([Severity], "minor")` |
| `COALESCE(value, value, …)` | The first value that is not empty | `COALESCE([Mobile], [Phone], [Office phone])` |
| `ISEMPTY(value)` | True when the value is empty or only spaces | `ISEMPTY([Closed on])` |

Only the part that is needed is worked out. In `IF(ISEMPTY([Qty]), 0, 100 / [Qty])`, the division is never tried for an empty Qty. The same goes for `IFS`, `SWITCH`, `IFEMPTY` and `COALESCE`.

### Numbers

| Function | What it gives | Example | Result |
|---|---|---|---|
| `NUMBER(text, decimal mark)` | Reads a number. The decimal mark is `"."` (the default, commas are thousands) or `","` (full stops are thousands) | `NUMBER("1.234,50", ",")` | `1234.5` |
| `ROUND(number, places)` | Rounded to 0–10 decimal places; none when not given | `ROUND(2.345, 2)` | `2.35` |
| `ABS(number)` | Without its sign | `ABS(-4)` | `4` |
| `MIN(number, number, …)` | The smallest, leaving out empty values | `MIN([Price 1], [Price 2])` | the lower price |
| `MAX(number, number, …)` | The largest, leaving out empty values | `MAX([Qty], 1)` | Qty, at least 1 |
| `CONVERT(number, "from", "to")` | Between units: length `mm` `cm` `m` `in` `ft`; mass `g` `kg` `lb` `oz`; temperature `c` `f` | `CONVERT(0.5, "in", "mm")` | `12.7` |

### Dates

| Function | What it gives | Example | Result |
|---|---|---|---|
| `DATE(text, "format")` | Reads a date (see the formats below) | `DATE("03.11.2026", "dd.MM.yyyy")` | `2026-11-03` |
| `TODAY()` | Today's date, in UTC | `TODAY()` | the date of the import |
| `ADDDAYS(date, days)` | The date that many days later, or earlier when negative | `ADDDAYS(DATE([Received]), 30)` | 30 days after Received |
| `YEAR(date)` | The year | `YEAR(DATE("2026-11-03"))` | `2026` |
| `MONTH(date)` | The month, 1–12 | `MONTH(DATE("2026-11-03"))` | `11` |
| `DAY(date)` | The day of the month | `DAY(DATE("2026-11-03"))` | `3` |

The format for `DATE` is one of these:

- `"iso"`, the default: year-month-day, such as `2026-11-03`. A time after the date is ignored.
- `"dmy"`: day/month/year, such as `3/11/2026`, `03.11.26` or `3-11-2026`.
- `"mdy"`: month/day/year, the American order, such as `11/3/2026`.
- `"excel"`: the day number Excel stores behind a date, such as `46329`. A five-digit number is read this way whatever the format.
- **A pattern** built from `yyyy` (four-digit year), `yy` (two-digit year, read as 20yy), `MM` and `M` (month with or without a leading zero) and `dd` and `d` (the day the same way). Any other characters must appear exactly as written. Examples: `"dd.MM.yyyy"`, `"yyyyMMdd"`, `"d/M/yy"`. The month is a capital `M`.

A date that does not exist, such as 31 February, is an error.

## When a formula goes wrong

**Mistakes in the formula itself** are found as you type, and the template can't be saved until they are fixed. The editor tells you where the problem is (counting characters from 1) and what it expected:

- `Position 13: This text has no closing "`
- `Position 1: there is no function UPPPER — did you mean UPPER?`
- `Position 1: IF needs 2 or 3 values, got 4 (IF(test, then, else))`
- `Column [Stauts] is not in the file — did you mean [Status]?`
- `"Leeds" is not something a formula knows: write a column as [Leeds], text as "Leeds", or a function as LEEDS(…)`

**Problems with a record's values** show up when the formula is worked out for that record, for example text where a number is needed, a date in the wrong format or dividing by zero. Fortress never guesses in these cases:

- **For a field**, the record is rejected with the reason, such as `Quantity: NUMBER needs a number, got "n/a"`. It is listed with the run's rejected rows, and nothing is written for it. Fix the source, or make the formula handle that case (`IF`, `IFEMPTY`), then import again.
- **For a filter**, the record is not read, and it is listed as rejected with `Filter formula: …`. It is not quietly dropped, so you can see the formula doesn't cover every record.

**Limits.** A formula may take up to 20,000 small steps for one record. A text it builds can be up to 10,000 characters long. Real formulas come nowhere near these limits; they only stop runaway mistakes.

## Formulas or steps?

Each field can also have **steps** (trim, replace, translate, number, date, round, convert and so on), which run after the column or formula.

- **Use steps** for simple clean-ups of one column. They are easier for the next person to read.
- **Use a formula** when the value depends on several columns, on a condition, or on working something out. A formula and steps can be used together: the formula builds the value and the steps tidy it.

## Examples

### Field formulas

| What you need | Formula |
|---|---|
| A full name from two columns | `[First name] & " " & [Surname]` |
| A part number made of a prefix and a number | `CONCAT([Prefix], "-", [Number])` |
| A tidy code in capitals | `UPPER(TRIM([Part]))` |
| Your status codes translated to Fortress's | `SWITCH([Status], "A", "active", "I", "inactive", "active")` |
| A default when the source leaves it blank | `IFEMPTY([Severity], "minor")` |
| Severity worked out from the quantity | `IF(NUMBER([Qty]) > 100, "major", "minor")` |
| A date written as 03.11.2026 | `DATE([Raised], "dd.MM.yyyy")` |
| A due date 30 days after receipt | `ADDDAYS(DATE([Received], "dmy"), 30)` |
| A diameter in inches stored in millimetres | `ROUND(CONVERT(NUMBER([Diameter]), "in", "mm"), 3)` |
| A price written with a decimal comma | `NUMBER([Price], ",")` |
| The line number after the "/" in `PO-1/20` | `SPLIT([Order line], "/", -1)` |
| The text before the first "-" (empty when there is none) | `LEFT([Part], FIND("-", [Part]) - 1)` |
| The first phone number given | `COALESCE([Mobile], [Phone])` |
| Leave a delivery row out when it is a correction | `IN([Movement type], "CORR", "REV")` (on the goods receipt field **Leave this row out**) |

### Filter formulas

| Read only… | Formula |
|---|---|
| Active records with a quantity | `[Status] = "Active" AND NUMBER([Qty]) > 0` |
| Two sites | `IN([Site], "LEEDS", "HULL")` |
| Rows that have a part number | `NOT ISEMPTY([Part number])` |
| Records from 2024 on | `YEAR(DATE([Date], "dmy")) >= 2024` |
| Everything except samples and test parts | `NOT (LEFT([Part], 2) = "SA" OR [Type] = "Test")` |

To turn any of these around, choose **Read every record except those that match** in the filter step.

## Related guides

- [Import your data](/help/import-your-data) covers the import steps, templates and what each kind of record needs.
- [Start with a spreadsheet, connect your database later](/help/spreadsheet-then-database) explains how the same template carries over when the source changes.
