// 파이어베이스 설정 파일
// README.md의 "2. 파이어베이스 설정" 순서대로 아래 값을 바꿔 넣으세요.
// 이 값들은 웹 앱에 공개되어도 괜찮은 값입니다.

export const firebaseConfig = {
  apiKey: "AIzaSyCi4Zb4526swem_EkXRLNg7dJ8mxYH-ZqI",
  authDomain: "overload-801d5.firebaseapp.com",
  projectId: "overload-801d5",
  storageBucket: "overload-801d5.firebasestorage.app",
  messagingSenderId: "50123424920",
  appId: "1:50123424920:web:78dd994909e678e1e93ced"
};

// 처음 관리자 비밀번호의 SHA-256 해시 값 (비밀번호 자체는 코드에 적지 않음)
// 비밀번호는 관리자 화면의 "관리자 비밀번호 바꾸기"에서 바꿉니다. 이 값은 고치지 않아도 됩니다.
// firestore.rules의 defaultKey()와 같은 값이어야 합니다.
export const ADMIN_PASSWORD_HASH = "f039fe66d6d713c9acf6ece68827af07a58999ca16a500266edb6bfd2f6d3500";

// 응답을 저장할 Firestore 컬렉션 이름
export const COLLECTION = "responses";
