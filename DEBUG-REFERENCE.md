# Quick Debug Reference - File Upload

## 🚨 Problem Symptoms
1. File not showing in chat after upload
2. File not reaching AI model
3. No visual confirmation of file attachment

## 🔍 Debug Messages (Expected Sequence)

| Step | Message | Location | Meaning |
|------|---------|----------|---------|
| 1 | `[DEBUG] File selected: test.txt (XXX bytes)` | Chat UI | File picker worked |
| 2 | `[DEBUG] File loaded: test.txt (XXX chars)` | Chat UI | FileReader succeeded |
| 3 | `[DEBUG] Preview bar shown` | Chat UI | Preview UI working |
| 4 | `[DEBUG] Preparing to send file: test.txt (XXX chars)` | Chat UI | State captured before send |
| 5 | `[DEBUG] File content prepended. Total text: XXX chars` | Chat UI | File added to message |
| 6 | `[DEBUG] File card added to chat bubble` | Chat UI | Visual card created |
| 7 | `[DEBUG] Message sent to AI (XXX chars)` | Chat UI | Port message posted |
| 8 | `[DEBUG] Service worker received file: test.txt (XXX chars)` | AI Response | Backend received it |

## ⚠️ Warning Messages

| Warning | Meaning | Fix |
|---------|---------|-----|
| `WARNING: Preview bar not found` | UI element missing | Check HTML structure |
| `WARNING: fileName exists but no fileContext!` | State cleared too early | Timing issue in sendMessage() |
| `ERROR: File too large` | File > 10MB | Use smaller file |
| `ERROR: Failed to read file` | FileReader error | Check file permissions |
| `ERROR: Cannot create file card - no content!` | fileContext is null | State management bug |

## 🐛 Diagnostic Decision Tree

```
No debug messages at all?
├─ YES → Debug mode not working, check build
└─ NO → Continue...

"File selected" shows but nothing else?
├─ YES → FileReader failed
│   └─ Check: File type, size, permissions
└─ NO → Continue...

"File loaded" shows but no "Preview bar shown"?
├─ YES → Preview UI elements missing
│   └─ Check: HTML elements .attachment-preview-bar exist
└─ NO → Continue...

"Preparing to send" but no "File content prepended"?
├─ YES → fileContext lost between steps
│   └─ Check: State clearing timing in sendMessage()
└─ NO → Continue...

"File card added" but card not visible?
├─ YES → CSS issue or card not appended
│   └─ Check: .file-attachment-card styles, bubble.appendChild()
└─ NO → Continue...

"Message sent" but no "Service worker received"?
├─ YES → Message format wrong or port broken
│   └─ Check: Text includes "[Attached file:", Port connection
└─ NO → Success! File reached AI
```

## 🔬 Console Log Filters

Open DevTools (F12) → Console → Filter by:

1. **`[FILE UPLOAD]`** - File reading process
   ```
   [FILE UPLOAD] attachFile called
   [FILE UPLOAD] File classification
   [FILE UPLOAD] ✅ Text file loaded successfully
   ```

2. **`[SEND MESSAGE]`** - Message preparation
   ```
   [SEND MESSAGE] 📊 Attachment state
   [SEND MESSAGE] ✅ File content prepended to text
   [SEND MESSAGE] 📎 Creating file attachment card
   [SEND MESSAGE] 📤 FINAL MESSAGE TO AI
   ```

3. **`[AI CHAT]`** - Service worker reception
   ```
   [AI CHAT] 📨 RECEIVED MESSAGE FROM SIDEPANEL
   [AI CHAT] 📎 FILE ATTACHMENT DETECTED
   ```

4. **`[FILE CARD]`** - UI card creation
   ```
   [FILE CARD] 📎 Creating file attachment card
   [FILE CARD] 📊 File details
   [FILE CARD] ✅ File card fully created
   ```

## 📋 Quick Test Procedure

1. Reload extension: `chrome://extensions` → Update
2. Open test page: `file:///path/to/test-file-upload.html`
3. Create test file: Copy content from page, save as `test.txt`
4. Open DevTools (F12) → Console tab
5. Open Orion sidepanel
6. Click 📎 paperclip icon
7. Select `test.txt`
8. Type: "analyze this file"
9. Press Send
10. Check chat for [DEBUG] messages
11. Check console for detailed logs

## 🎯 Success Criteria

✅ All 8 debug messages appear in order
✅ File card visible in user bubble
✅ AI responds with file content analysis
✅ No warnings or errors

## 🔧 Common Fixes

### File card not showing
- Check CSS: `.file-attachment-card` styles exist
- Check function: `createFileAttachmentCard()` at line 3150
- Check append: `bubble.appendChild(fileCard)`

### File not reaching AI
- Check format: `[Attached file: name]\n\`\`\`\ncontent\n\`\`\``
- Check detection: Regex `/\[Attached file: (.+?)\]/`
- Check extraction: Regex `/\`\`\`\n([\s\S]+?)\n\`\`\``/

### State cleared too early
- Check timing: `state._clearAttachment()` called after capturing
- Check order: Capture fileContext/fileName BEFORE clearing
- Check: Line 2916-2918 in sendMessage()

## 📁 Relevant Files

| File | Line | Function |
|------|------|----------|
| `src/sidepanel/chat.ts` | 77 | `showDebugMessage()` |
| `src/sidepanel/chat.ts` | 735 | `attachFile()` |
| `src/sidepanel/chat.ts` | 2880 | `sendMessage()` - file handling |
| `src/sidepanel/chat.ts` | 3150 | `createFileAttachmentCard()` |
| `src/background/service-worker.ts` | 934 | File detection in handleAIChat() |
| `src/sidepanel/sidepanel.html` | 453 | `.file-attachment-card` CSS |

## 🧪 Test Files

- `/Users/s/my/PrivateWebAssistent/test-file-upload.html` - Test page
- `/Users/s/my/PrivateWebAssistent/FILE-UPLOAD-DEBUG-SUMMARY.md` - Full details
- `/Users/s/my/PrivateWebAssistent/DEBUG-REFERENCE.md` - This file
