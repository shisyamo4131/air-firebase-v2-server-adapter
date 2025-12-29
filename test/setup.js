import admin from "firebase-admin";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// __dirname の取得（ES Modules では必要）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// サービスアカウントキーの読み込み
const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, "service-account.json"), "utf8")
);

// Firebase Admin を初期化
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
});

const firestore = admin.firestore();

export { admin, firestore };
