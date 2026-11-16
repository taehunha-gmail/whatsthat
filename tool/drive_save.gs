// 저게뭐야? — 찰칵 사진을 내 구글 드라이브 «저게뭐야 사진» 폴더에 저장한다(Cloudflare Worker 가 부른다).
// 쓰는 법(AI_HANDOFF.md 4절): 드라이브를 쓰는 구글 계정으로 script.google.com → 새 프로젝트 → 이 코드를 통째로 붙여 넣기 → 저장
//   → 배포 → 새 배포 → 유형 «웹 앱»(실행: 나 · 액세스: 모든 사용자) → 권한 허용 → 나온 «웹 앱 URL»을 Worker 의 DRIVE_URL(Secret)에 넣는다.
// 그 주소를 아는 쪽은 이 폴더에 사진을 넣을 수 있으므로 암호처럼 다룬다(Worker 만 알고, 앱·저장소에는 적지 않는다).
const FOLDER = '저게뭐야 사진';

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    const it = DriveApp.getFoldersByName(FOLDER);
    const folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER);
    const blob = Utilities.newBlob(Utilities.base64Decode(p.data), 'image/jpeg', String(p.name || '저게뭐야.jpg'));
    const f = folder.createFile(blob);
    return out({ ok: true, id: f.getId(), name: f.getName() });
  } catch (err) {
    return out({ ok: false, error: String(err).slice(0, 200) });
  }
}

// 웹 앱 주소를 브라우저로 열면 {"ok":true,…} 가 보인다 — 배포가 됐는지 확인용
function doGet() {
  return out({ ok: true, app: '저게뭐야 드라이브 저장', folder: FOLDER });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
