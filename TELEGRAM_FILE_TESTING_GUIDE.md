# Telegram File Upload Testing Guide

## Prerequisites

1. **Telegram Bot Setup**
   - Create a bot via [@BotFather](https://t.me/BotFather)
   - Get bot token (format: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
   - Open chat with your bot on Telegram

2. **Extension Setup**
   - Build: `npm run build`
   - Load extension in Chrome: `chrome://extensions` → Load unpacked → `dist/`
   - Open extension settings (click extension icon)
   - Enable "Telegram Bot Integration"
   - Enter bot token
   - Add your Telegram chat ID to allowed list
   - Save settings

3. **Verify Connection**
   - In Telegram, send `/start` to your bot
   - Should receive welcome message with command list
   - In Chrome DevTools console, should see: `[Telegram] Polling started`

## Test Cases

### Test 1: File Only Upload (Text File)

**Steps:**
1. Create a test file `test.txt`:
   ```
   This is a test file.
   It has multiple lines.
   Please analyze this content.
   ```
2. In Telegram, attach the file (📎 button) without any caption
3. Send the file

**Expected:**
- Console log: `[Telegram] 📎 File attachment detected: { fileName: 'test.txt', fileId: '...', size: ..., mimeType: 'text/plain' }`
- Console log: `[Telegram] Downloading file: { fileName: 'test.txt', ... }`
- Console log: `[Telegram] ✅ File downloaded: { fileName: 'test.txt', contentLength: ..., truncated: false }`
- Console log: `[Telegram] ✅ File content prepended, total length: ...`
- Bot replies: `📎 Received file: *test.txt* (... bytes)\nAnalyzing...`
- Bot then analyzes file content and provides response

**Verification:**
- AI should have access to file content
- AI response should reference the file content

---

### Test 2: File + Caption Upload

**Steps:**
1. Create `data.json`:
   ```json
   {
     "users": [
       {"name": "Alice", "age": 30},
       {"name": "Bob", "age": 25}
     ]
   }
   ```
2. In Telegram, attach the file
3. Add caption: "What is the average age?"
4. Send

**Expected:**
- Console logs same as Test 1
- Bot replies: `📎 Received file: *data.json* (... bytes)\nAnalyzing...`
- Bot analyzes both file content AND caption
- AI response should calculate average age (27.5) from the JSON data

**Verification:**
- AI should answer the specific question about the data
- Response should show understanding of both JSON structure and question

---

### Test 3: Unsupported File Type

**Steps:**
1. Find any image file (e.g., `photo.jpg`)
2. In Telegram, attach and send the image file

**Expected:**
- Console log: `[Telegram] 📎 File attachment detected: { fileName: 'photo.jpg', ... }`
- Console log: `[Telegram] Skipping non-text file: photo.jpg`
- Bot replies: `⚠️ Could not process file: *photo.jpg*\nSupported formats: .txt, .md, .json, .csv, .log, .xml, .html, code files`
- No AI analysis occurs

**Verification:**
- User is clearly informed about supported formats
- No error in console (graceful handling)

---

### Test 4: Large File (50KB+ Truncation)

**Steps:**
1. Create a large text file:
   ```bash
   python3 -c "print('This is line number N\n' * 10000)" > large.txt
   ```
   (This creates ~200KB file)
2. In Telegram, attach and send `large.txt`

**Expected:**
- Console log: `[Telegram] ✅ File downloaded: { fileName: 'large.txt', contentLength: 50000, truncated: true }`
- Bot replies: `📎 Received file: *large.txt* (... bytes)\nAnalyzing...`
- AI analyzes first 50KB only

**Verification:**
- File is processed despite being large
- Console shows `truncated: true`
- No errors or timeouts

---

### Test 5: Code File Analysis

**Steps:**
1. Create `example.py`:
   ```python
   def factorial(n):
       if n <= 1:
           return 1
       return n * factorial(n-1)

   # Calculate factorial of 5
   result = factorial(5)
   print(f"Factorial of 5 is {result}")
   ```
2. Attach with caption: "Explain this code"
3. Send

**Expected:**
- Console logs show successful processing
- Bot replies with code analysis
- AI explains:
  - Function purpose (recursive factorial)
  - How recursion works
  - Example calculation (5! = 120)

**Verification:**
- AI recognizes Python syntax
- AI explains algorithm correctly

---

### Test 6: Config File Analysis

**Steps:**
1. Create `config.yml`:
   ```yaml
   server:
     host: localhost
     port: 8080
   database:
     type: postgresql
     host: db.example.com
     port: 5432
   ```
2. Attach with caption: "What is the database configuration?"
3. Send

**Expected:**
- File processed successfully
- AI reads YAML structure
- AI responds with database config details:
  - Type: postgresql
  - Host: db.example.com
  - Port: 5432

**Verification:**
- YAML parsing works
- AI extracts correct information

---

### Test 7: Multiple Files in Sequence

**Steps:**
1. Send `file1.txt` with caption "remember this"
2. Wait for response
3. Send `file2.txt` with caption "compare with previous file"

**Expected:**
- Both files processed independently
- Second message should reference session history
- AI should compare both files using session context

**Verification:**
- Session memory works across file uploads
- Each file is processed completely

---

### Test 8: Empty File

**Steps:**
1. Create empty file: `touch empty.txt`
2. Attach and send

**Expected:**
- File downloads successfully
- Console: `[Telegram] ✅ File downloaded: { fileName: 'empty.txt', contentLength: 0, truncated: false }`
- Bot processes empty content
- AI responds appropriately (e.g., "The file appears to be empty")

**Verification:**
- No crashes or errors
- Graceful handling of empty content

---

### Test 9: Special Characters in Filename

**Steps:**
1. Create file with special chars: `test file (copy) [1].txt`
2. Add content: "Test content"
3. Attach and send

**Expected:**
- File processes normally
- Console logs show full filename correctly
- Bot responds normally

**Verification:**
- Spaces, parentheses, brackets handled correctly
- No parsing errors

---

### Test 10: CSV Data Analysis

**Steps:**
1. Create `sales.csv`:
   ```csv
   Date,Product,Revenue
   2024-01-01,Widget A,1200
   2024-01-02,Widget B,800
   2024-01-03,Widget A,1500
   ```
2. Attach with caption: "What was the total revenue?"
3. Send

**Expected:**
- CSV parsed successfully
- AI calculates: 1200 + 800 + 1500 = 3500
- AI responds with total: $3,500 or 3500

**Verification:**
- CSV data extracted correctly
- Mathematical calculations accurate

---

## Console Monitoring

Open Chrome DevTools (F12) → Console tab → Filter: "Telegram"

### Success Indicators:
```
[Telegram] 📎 File attachment detected: { fileName: '...', fileId: '...', size: ..., mimeType: '...' }
[Telegram] Downloading file: { fileName: '...', filePath: '...', downloadUrl: 'https://api.telegram.org/file/botTOKEN/...' }
[Telegram] ✅ File downloaded: { fileName: '...', contentLength: ..., truncated: false }
[Telegram] ✅ File content prepended, total length: ...
```

### Error Indicators:
```
[Telegram] Skipping non-text file: ...
[Telegram] Failed to get file path: ...
[Telegram] Download failed: 404 Not Found
[Telegram] Error downloading file: ...
```

---

## Troubleshooting

### File not detected
- **Check:** Is file attachment visible in Telegram app?
- **Check:** Console for any errors
- **Fix:** Try re-attaching file

### Download fails
- **Check:** Bot token is correct
- **Check:** Internet connection
- **Fix:** Test with `/status` command first

### No AI response
- **Check:** Console for error messages
- **Check:** AI provider settings (Gemini API key, etc.)
- **Fix:** Test with regular text message first

### File too large
- Files over 20MB may timeout
- Telegram Bot API has 20MB limit
- Extension truncates to 50KB internally

### Wrong format detected
- **Check:** File extension is in supported list
- **Fix:** Rename file with correct extension

---

## Success Criteria

✅ All 10 test cases pass
✅ Console shows expected log messages
✅ Bot responds appropriately to each file type
✅ AI has access to file content
✅ No JavaScript errors in console
✅ Unsupported files are rejected gracefully
✅ Large files are truncated without errors
✅ Session context preserved across file uploads

---

## Additional Testing

### Edge Cases
- [ ] File with no extension
- [ ] File with double extension (e.g., `archive.tar.gz`)
- [ ] File with Unicode characters in name (e.g., `文件.txt`, `файл.txt`)
- [ ] File larger than 20MB (should timeout gracefully)
- [ ] Simultaneous file uploads from different chats
- [ ] File upload while AI is processing previous message

### Integration Tests
- [ ] Upload file, then use `/screenshot` command
- [ ] Upload file, then use `/tabs` command
- [ ] Upload file, then switch tabs with `/tab N`
- [ ] Upload file, then `/clear` and upload another

### Performance Tests
- [ ] Upload 10 files in quick succession
- [ ] Upload very large file (18MB) - should complete within 30s
- [ ] Upload file during high AI load

---

## Report Template

```
# Telegram File Upload Test Report

**Date:** YYYY-MM-DD
**Tester:** [Name]
**Build:** v1.0.27

## Test Results

| Test # | Description | Status | Notes |
|--------|-------------|--------|-------|
| 1 | File only upload | ✅/❌ | |
| 2 | File + caption | ✅/❌ | |
| 3 | Unsupported file | ✅/❌ | |
| 4 | Large file (50KB+) | ✅/❌ | |
| 5 | Code file analysis | ✅/❌ | |
| 6 | Config file | ✅/❌ | |
| 7 | Multiple files | ✅/❌ | |
| 8 | Empty file | ✅/❌ | |
| 9 | Special chars in name | ✅/❌ | |
| 10 | CSV data analysis | ✅/❌ | |

## Issues Found

1. [Issue description]
   - Steps to reproduce
   - Expected vs actual behavior
   - Console errors (if any)

## Console Logs

```
[Paste relevant console logs here]
```

## Recommendations

[Any suggestions for improvement]
```
