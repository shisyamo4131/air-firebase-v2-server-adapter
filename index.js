/**
 * サーバー側で使用する FireModel のアダプターです。
 * FireModel に Firestore に対する CRUD 機能を注入します。
 */
import { logger } from "firebase-functions";

class ServerAdapter {
  static firestore = null;

  constructor() {
    ServerAdapter.firestore = getFirestore();
  }

  /**
   * console を返します。
   * FireModel でコンソールを出力するために使用します。
   */
  get logger() {
    return logger;
  }

  /**
   * Firestore のトランザクションを使用して、インスタンスに採番を行います。
   * - `Autonumbers` コレクションから、現在の自動採番ドキュメントを取得します。
   * - 採番可能である場合、現在値をインクリメントし、新しい採番コードをインスタンスにセットします。
   * - `current` 値を更新するための関数を返します。（更新処理は呼び出し元で実行）
   *
   * @param {Object} transaction - Firestore のトランザクションオブジェクト（必須）
   * @returns {Promise<Function>} - Firestore の `current` 値を更新するための関数
   * @throws {Error} - `Autonumbers` コレクションに対象コレクションのドキュメントが存在しない場合
   * @throws {Error} - 採番が無効化されている (`status: false`) 場合
   * @throws {Error} - 採番の最大値 (`10^length - 1`) に達した場合
   */
  async setAutonumber(transaction) {
    if (!transaction) {
      throw new Error("transaction is required.");
    }

    try {
      const collectionPath = this.constructor.collectionPath;
      const docRef = ServerAdapter.firestore
        .collection("Autonumbers")
        .doc(collectionPath);

      // Firestore のトランザクションスコープ内でドキュメントを取得
      const docSnap = await transaction.get(docRef);
      if (!docSnap.exists) {
        throw new Error(
          `Could not find Autonumber document. collection: ${collectionPath}`
        );
      }

      const data = docSnap.data();

      if (!data?.status) {
        throw new Error(
          `Autonumber is disabled. collection: ${collectionPath}`
        );
      }

      // 採番するコードを生成
      const newNumber = data.current + 1;
      const length = data.length;
      const maxValue = Math.pow(10, length) - 1; // 最大値を 10^length - 1 に変更
      if (newNumber > maxValue) {
        throw new Error(
          `The maximum value for Autonumber has been reached. collection: ${collectionPath}`
        );
      }

      const newCode = String(newNumber).padStart(length, "0"); // `padStart()` を使ってゼロ埋め
      this[data.field] = newCode;

      // `current` 値を更新する関数を返す（呼び出し元で実行）
      return () => transaction.update(docRef, { current: newNumber });
    } catch (err) {
      console.error(
        `[ServerAdapter.js - setAutonumber] An error has occurred:`,
        err
      );
      throw err;
    }
  }

  /**
   * Firestore にドキュメントを作成します。
   * - ドキュメントの作成は必ずトランザクション処理で実行されます。
   *   引数 transaction が与えられなかった場合、この関数内でトランザクションが生成されます。
   * - `docId` を指定しない場合、Firestore により自動で ID が割り当てられます。
   * - `useAutonumber` を `true` にすると、自動採番 (`setAutonumber()`) を実行します。
   *   但し、自動採番を行うためにはクラスの useAutonumber が true である必要があります。
   * - `callBack` が指定されている場合、ドキュメント作成後にコールバック関数を実行します。
   *
   * @param {Object} args - ドキュメント作成のためのパラメータ
   * @param {string|null} [args.docId] - 作成するドキュメントのID（オプション）
   * @param {boolean} [args.useAutonumber=true] - `true` の場合、自動採番を実行します。
   * @param {Object|null} [args.transaction] - Firestore のトランザクションオブジェクト
   * @param {function|null} [args.callBack] - ドキュメント作成後に実行するコールバック関数です。
   * @returns {Promise<DocumentReference>} - 作成されたドキュメントの参照を返します。
   * @throws {Error} - `callBack` が関数でない場合はエラーをスローします。
   * @throws {Error} - Firestore への書き込みに失敗した場合はエラーをスローします。
   */
  async create({
    docId = null,
    useAutonumber = true,
    transaction = null,
    callBack = null,
  }) {
    // callBackがnull以外の場合は関数であることを確認
    if (callBack !== null && typeof callBack !== "function") {
      throw new Error(`callBack must be a function.`);
    }

    try {
      await this.beforeCreate();
      this.validate();

      /**
       * create 関数内で使用するトランザクション処理
       * @param {Object} txn - Firestore のトランザクションオブジェクト
       */
      const performTransaction = async (txn) => {
        const updateAutonumber =
          this.constructor.useAutonumber && useAutonumber
            ? await this.setAutonumber(txn)
            : null;

        // ドキュメントの参照を取得
        const collectionPath = this.constructor.collectionPath;
        const colRef = firestore
          .collection(collectionPath)
          .withConverter(this.converter());
        const docRef = docId ? colRef.doc(docId) : colRef.doc();

        // FireModel の既定プロパティを編集
        this.docId = docRef.id;
        this.createdAt = new Date();
        this.updatedAt = new Date();
        this.uid = "cloud functions";
        txn.set(docRef, this);
        if (updateAutonumber) await updateAutonumber();
        if (callBack) await callBack(txn);
        return docRef;
      };

      // トランザクションを実行して作成したドキュメントへの参照を取得
      const docRef = transaction
        ? await performTransaction(transaction)
        : await ServerAdapter.firestore.runTransaction(performTransaction);

      // ドキュメントへの参照を返す
      return docRef;
    } catch (err) {
      console.error(`[ServerAdapter.js - create] An error has occured.`, err);
      throw err;
    }
  }

  /**
   * 指定された ID に該当するドキュメントを Firestore から取得し、インスタンスに読み込みます。
   * - ドキュメントが存在しない場合、インスタンスのデータをリセット (`initialize(null)`) します。
   * - `transaction` が指定されている場合、トランザクションを使用して取得します。
   * - `transaction` が `null` の場合、通常の `getDoc()` を使用して取得します。
   *
   * @param {string} docId - 取得するドキュメントのIDです。
   * @param {Object|null} [transaction=null] - Firestore のトランザクションオブジェクトです。（オプション）
   * @returns {Promise<boolean>} - ドキュメントが存在した場合は `true`、存在しない場合は `false` を返します。
   * @throws {Error} - `docId` が指定されていない場合、または Firestore の取得処理に失敗した場合
   */
  async fetch(docId, transaction = null) {
    if (!docId) {
      throw new Error("docId is required.");
    }

    try {
      const collectionPath = this.constructor.collectionPath;
      const colRef = firestore
        .collection(collectionPath)
        .withConverter(this.converter());
      const docRef = colRef.doc(docId);

      // Firestore からドキュメントを取得します。
      const docSnap = transaction
        ? await transaction.get(docRef)
        : await docRef.get();

      // ドキュメントが存在する場合はインスタンスにデータをセットし、存在しない場合はリセットします。
      this.initialize(docSnap.exists ? docSnap.data() : null);

      return docSnap.exists;
    } catch (err) {
      console.error("[ServerAdapter.js - fetch] An error has occurred:", err);
      throw err;
    }
  }

  /**
   * Firestore から指定された ID に該当するドキュメントを取得し、新しいオブジェクトとして返します。
   * - `fetch()` はこのクラスのインスタンスにデータをセットしますが、`fetchDoc()` は新しいオブジェクトとして返します。
   * - `transaction` が指定されている場合、トランザクションを使用して取得します。
   * - `transaction` が `null` の場合、通常の `getDoc()` を使用して取得します。
   *
   * @param {string} docId - 取得するドキュメントのIDです。
   * @param {Object|null} [transaction=null] - Firestore のトランザクションオブジェクトです。（オプション）
   * @returns {Promise<Object|null>} - 取得したデータオブジェクトを返します。ドキュメントが存在しない場合は `null` を返します。
   * @throws {Error} - `docId` が指定されていない場合、または Firestore の取得処理に失敗した場合
   */
  async fetchDoc(docId, transaction = null) {
    if (!docId) throw new Error(`docId is required.`);

    try {
      const collectionPath = this.constructor.collectionPath;
      const colRef = firestore
        .collection(collectionPath)
        .withConverter(this.converter());
      const docRef = colRef.doc(docId);
      const docSnap = transaction
        ? await transaction.get(docRef)
        : await docRef.get();

      return docSnap.exists ? docSnap.data() : null;
    } catch (err) {
      console.error(
        "[ServerAdapter.js - fetchDoc] An error has occurred:",
        err
      );
      throw err;
    }
  }

  /**
   * Firestore のクエリ条件の配列を受け取り、Firestore のクエリオブジェクト配列を生成して返します。
   * - `constraints` 配列には、`where`, `orderBy`, `limit` などの Firestore クエリを指定できます。
   * - 例：`[['where', 'age', '>=', 18], ['orderBy', 'age', 'desc'], ['limit', 10]]`
   * - 不明なクエリタイプが指定された場合はエラーをスローします。
   *
   * @param {Array} constraints - クエリ条件の配列です。
   * @returns {Array<Object>} - Firestore クエリオブジェクトの配列を返します。
   * @throws {Error} - 不明なクエリタイプが指定された場合、エラーをスローします。
   */
  createQueries(constraints) {
    const result = [];
    const validQueryTypes = ["where", "orderBy", "limit"];

    constraints.forEach((constraint) => {
      const [type, ...args] = constraint;

      switch (type) {
        case "where":
          result.push(where(...args));
          break;
        case "orderBy":
          if (!["asc", "desc"].includes(args[1] || "asc")) {
            console.error(
              "[ServerAdapter.js - createQueries] Invalid orderBy direction:",
              args[1]
            );
            throw new Error(
              `Invalid orderBy direction: ${args[1]}. Use "asc" or "desc".`
            );
          }
          result.push(orderBy(args[0], args[1] || "asc"));
          break;
        case "limit":
          if (typeof args[0] !== "number" || args[0] <= 0) {
            console.error(
              "[ServerAdapter.js - createQueries] Invalid limit value:",
              args[0]
            );
            throw new Error(
              `Invalid limit value: ${args[0]}. Must be a positive number.`
            );
          }
          result.push(limit(args[0]));
          break;
        default:
          console.error(
            "[ServerAdapter.js - createQueries] Invalid query type:",
            type
          );
          throw new Error(
            `Invalid query type: ${type}. Please use one of: ${validQueryTypes.join(
              ", "
            )}`
          );
      }
    });
    return result;
  }

  /**
   * Firestore の `tokenMap` に基づく N-Gram 検索用のクエリオブジェクトを生成します。
   * - 検索文字列の 1 文字・2 文字ごとのトークンを作成し、Firestore の `tokenMap` を利用した検索クエリを生成します。
   * - 例：`"検索"` → `['検', '索', '検索']`
   * - サロゲートペア文字（絵文字など）は Firestore の `tokenMap` では検索対象としないため除外します。
   *
   * @param {string} constraints - 検索に使用する文字列です。
   * @returns {Array<Object>} - Firestore クエリオブジェクトの配列を返します。
   * @throws {Error} - `constraints` が空文字の場合、エラーをスローします。
   */
  createTokenMapQueries(constraints) {
    if (!constraints || constraints.trim().length === 0) {
      throw new Error("Search string (constraints) cannot be empty.");
    }

    const result = new Set(); // クエリの重複を防ぐために `Set` を使用

    // サロゲートペア文字（絵文字など）を除外
    const target = constraints.replace(
      /[\uD800-\uDBFF]|[\uDC00-\uDFFF]|~|\*|\[|\]|\s+/g,
      ""
    );

    // 1 文字・2 文字のトークンを生成
    const tokens = [
      ...new Set([
        ...[...target].map((_, i) => target.substring(i, i + 1)), // 1 文字トークン
        ...[...target].map((_, i) => target.substring(i, i + 2)).slice(0, -1), // 2 文字トークン
      ]),
    ];

    // Firestore クエリオブジェクトを作成
    tokens.forEach((token) => {
      result.add(where(`tokenMap.${token}`, "==", true));
    });

    return Array.from(result); // `Set` を配列に変換して返す
  }

  /**
   * Firestore から条件に一致するドキュメントを取得します。
   * - 指定されたクエリ条件 (`constraints`) を適用して、Firestore のドキュメントを取得します。
   * - constraints は配列である必要があります。サーバー側では N-Gram 検索は出来ません。
   * - 取得結果は `this.converter()` を通じてオブジェクトの配列として返します。
   * - `transaction` が指定されている場合、トランザクション内で取得します。
   * - `transaction` が `null` の場合、通常の `getDocs()` を使用します。
   *
   * @param {Array|string} constraints - クエリ条件の配列
   * @param {Array} options - 追加のクエリ条件の配列（constraints が配列の場合は無視されます。）
   * @param {Object|null} [transaction=null] - Firestore のトランザクションオブジェクトです。（オプション）
   * @returns {Promise<Array<Object>>} - 取得したドキュメントのデータを配列として返します。
   * @throws {Error} - Firestore の取得処理に失敗した場合
   */
  async fetchDocs({ constraints = [], options = [] }, transaction = null) {
    const queryConstraints = [];
    // constraints は配列でなければエラー
    if (!constraints || !Array.isArray(constraints)) {
      throw new Error(
        `constraints must be an array. String parameter is not allowed on server side.`
      );
    }

    // options は配列でなければエラー
    if (options && !Array.isArray(constraints)) {
      throw new Error(`options must be an array.`);
    }

    try {
      const collectionPath = this.constructor.collectionPath;
      const colRef = firestore
        .collection(collectionPath)
        .withConverter(this.converter());

      // Firestore のクエリを作成
      let queryRef = colRef;
      [...constraints, ...options].forEach((constraint) => {
        const [type, ...args] = constraint;
        switch (type) {
          case "where":
            queryRef = queryRef.where(...args);
            break;
          case "orderBy":
            if (!["asc", "desc"].includes(args[1] || "asc")) {
              console.error(
                "[ServerAdapter.js - createQueries] Invalid orderBy direction:",
                args[1]
              );
              throw new Error(
                `Invalid orderBy direction: ${args[1]}. Use "asc" or "desc".`
              );
            }
            queryRef = queryRef.orderBy(args[0], args[1] || "asc");
            break;
          case "limit":
            if (typeof args[0] !== "number" || args[0] <= 0) {
              console.error(
                "[ServerAdapter.js - createQueries] Invalid limit value:",
                args[0]
              );
              throw new Error(
                `Invalid limit value: ${args[0]}. Must be a positive number.`
              );
            }
            queryRef = queryRef.limit(args[0]);
            break;
          default:
            warn(
              `Unknown query type: ${type}. Valid query types are: ${validQueryTypes.join(
                ", "
              )}`
            );
            throw new Error(
              `Invalid query type: ${type}. Please use one of: ${validQueryTypes.join(
                ", "
              )}`
            );
        }
      });

      // トランザクションの有無によって取得方法を分岐
      const querySnapshot = transaction
        ? await transaction.get(queryRef)
        : await queryRef.get();

      // 取得したドキュメントをデータの配列として返す
      return querySnapshot.docs.map((doc) => doc.data());
    } catch (err) {
      console.error(
        "[ServerAdapter.js - fetchDocs] An error has occurred:",
        err
      );
      throw err;
    }
  }

  /**
   * Firestore ドキュメントを現在のプロパティ値で更新します。
   * - `this.docId` が設定されていない場合はエラーをスローします。（`fetch()` を事前に呼び出す必要があります）
   * - `transaction` が指定されている場合、そのトランザクション内で処理を実行します。
   * - `transaction` が `null` の場合、新規で `runTransaction()` を実行します。
   * - `callBack` を指定すると、更新後に追加の処理を実行できます。
   *
   * @param {Object|null} [transaction=null] - Firestore のトランザクションオブジェクトです。（オプション）
   * @param {function|null} [callBack=null] - 更新後に独自の処理を実行する関数です。（オプション）
   * @returns {Promise<DocumentReference>} - 更新された Firestore ドキュメントの参照を返します。
   * @throws {Error} - `docId` が設定されていない場合（`fetch()` を事前に実行する必要があります）。
   * @throws {Error} - `callBack` が関数でない場合。
   * @throws {Error} - Firestore の更新処理中にエラーが発生した場合。
   */
  async update({ transaction = null, callBack = null } = {}) {
    // callBackがnull以外の場合は関数であることを確認
    if (callBack !== null && typeof callBack !== "function") {
      throw new Error(`callBack must be a function.`);
    }

    // docId が設定されていなければエラーをスロー
    if (!this.docId) {
      throw new Error(
        `The docId property is required for update(). Call fetch() first.`
      );
    }

    try {
      await this.beforeUpdate();
      this.validate();

      /**
       * update 関数内で使用するトランザクション処理
       * @param {Object} txn - Firestore のトランザクションオブジェクト
       */
      const performTransaction = async (txn) => {
        const collectionPath = this.constructor.collectionPath;
        const colRef = firestore
          .collection(collectionPath)
          .withConverter(this.converter());
        const docRef = colRef.doc(this.docId);

        // 更新準備
        this.updatedAt = new Date();
        this.uid = "cloud functions";

        txn.set(docRef, this);
        if (callBack) await callBack(txn);
        return docRef;
      };

      // トランザクションを実行して作成したドキュメントへの参照を取得
      const docRef = transaction
        ? await performTransaction(transaction)
        : await ServerAdapter.firestore.runTransaction(performTransaction);

      return docRef;
    } catch (err) {
      console.error(`[ServerAdapter.js - update] An error has occured.`);
      throw err;
    }
  }

  /**
   * `hasMany` プロパティにセットされた条件に基づき、現在のドキュメントに依存している子ドキュメントが
   * 存在しているかどうかを確認します。
   * @param {function|null} transaction - トランザクション処理を行うための関数（省略可能、デフォルトは `null`）
   * @returns {Promise<object|boolean>} - 子ドキュメントが存在する場合は `hasMany` の該当項目を返し、
   *                                      存在しない場合は `false` を返します。
   * @throws {Error} - Firestore の操作中にエラーが発生した場合にスローされます。
   */
  async hasChild(transaction = null) {
    // docId が設定されていなければエラーをスロー
    if (!this.docId) {
      throw new Error(
        `The docId property is required for delete(). Call fetch() first.`
      );
    }

    try {
      for (const item of this.constructor.hasMany) {
        // コレクションまたはコレクショングループの参照を取得
        const colRef =
          item.type === "collection"
            ? ServerAdapter.firestore.collection(item.collection)
            : ServerAdapter.firestore.collectionGroup(item.collection);

        // クエリを作成
        const queryRef = colRef
          .where(item.field, item.condition, this.docId)
          .limit(1);

        // トランザクションの有無に応じてクエリを実行
        const snapshot = transaction
          ? await transaction.get(queryRef)
          : await queryRef.get();

        // 子ドキュメントが存在する場合、該当の `hasMany` アイテムを返す
        if (!snapshot.empty) return item;
      }

      // 子ドキュメントが存在しない場合は `false` を返す
      return false;
    } catch (error) {
      console.error(`[ServerAdapter.js - hasChild] An error has occured.`);
      throw err;
    }
  }

  /**
   * 現在のドキュメントIDに該当するドキュメントを削除します。
   * - `logicalDelete`が指定されている場合、削除されたドキュメントは`archive`コレクションに移動されます。
   * - `transaction`が指定されている場合は`deleteAsTransaction`を呼び出します。
   * @param {function|null} transaction - トランザクション処理を行うための関数（省略可能、デフォルトは `null`）
   * @param {function|null} callBack - サブクラス側で独自の処理を実行するための関数（省略可能、デフォルトは `null`）
   * @returns {Promise<void>} - 処理が完了すると解決されるプロミス
   * @throws {Error} - コールバックが関数でない場合にエラーをスローします。
   * @throws {Error} - 自身にドキュメントIDが設定されていない場合にエラーをスローします。
   * @throws {Error} - 削除対象のドキュメントが存在しない場合にエラーをスローします。（論理削除時のみ）
   */
  async delete({ transaction = null, callBack = null } = {}) {
    // callBackがnull以外の場合は関数であることを確認
    if (callBack !== null && typeof callBack !== "function") {
      throw new Error(`callBack must be a function.`);
    }

    // docId が設定されていなければエラーをスロー
    if (!this.docId) {
      throw new Error(
        `The docId property is required for delete(). Call fetch() first.`
      );
    }

    try {
      await this.beforeDelete();

      const collectionPath = this.constructor.collectionPath;
      const colRef = ServerAdapter.firestore.collection(collectionPath);
      const docRef = colRef.doc(this.docId);

      /**
       * delete 関数内で使用するトランザクション処理
       * @param {Object} txn - Firestore のトランザクションオブジェクト
       */
      const performTransaction = async (txn) => {
        const hasChild = await this.hasChild(txn);
        if (hasChild) {
          throw new Error(
            `Cannot delete because the associated document exists in the ${hasChild.collection} collection.`
          );
        }

        // 論理削除区分が true の場合はドキュメントを archive に移動
        if (this.constructor.logicalDelete) {
          const sourceDocSnap = await txn.get(docRef);
          if (!sourceDocSnap.exists) {
            throw new Error(
              `The document to be deleted did not exist. The document ID is ${this.docId}.`
            );
          }
          const sourceDocData = sourceDocSnap.data();
          const archiveColRef = ServerAdapter.firestore.collection(
            `${collectionPath}_archive`
          );
          const archiveDocRef = archiveColRef.doc(this.docId);
          txn.set(archiveDocRef, sourceDocData);
        }

        // 削除処理
        txn.delete(docRef);

        // コールバックを実行
        if (callBack) await callBack(txn);
      };

      // ドキュメントの削除処理
      if (transaction) {
        await performTransaction(transaction);
      } else {
        await ServerAdapter.firestore.runTransaction(performTransaction);
      }
    } catch (err) {
      console.error(`[ServerAdapter.js - delete] An error has occured.`);
      throw err;
    }
  }

  /**
   * 削除されたドキュメントをアーカイブコレクションから元のコレクションに復元します。
   * @param {string} docId - 復元するドキュメントのID
   * @returns {Promise<DocumentReference>} - 復元されたドキュメントのリファレンス
   * @throws {Error} - ドキュメントIDが指定されていない場合や、復元するドキュメントが存在しない場合にエラーをスローします
   */
  async restore(docId) {
    if (!docId) throw new Error(`docId is required.`);
    try {
      const collectionPath = this.collectionPath;
      const archivePath = `${collectionPath}_archive`;
      const archiveColRef = ServerAdapter.firestore.collection(archivePath);
      const archiveDocRef = archiveColRef.doc(docId);
      const docSnapshot = await archiveDocRef.get();
      if (!docSnapshot.exists) {
        throw new Error(
          `Specified document is not found at ${collectionPath} collection. docId: ${docId}`
        );
      }
      const colRef = ServerAdapter.firestore.collection(collectionPath);
      const docRef = colRef.doc(docId);
      const batch = ServerAdapter.firestore.batch();
      batch.delete(archiveDocRef);
      batch.set(docRef, docSnapshot.data());
      await batch.commit();
      return docRef;
    } catch (err) {
      console.error(`[ServerAdapter.js - restore] An error has occured.`);
      throw err;
    }
  }

  /**
   * サーバー側では unsubscribe は実行できません。
   */
  unsubscribe() {
    throw new Error(`Can not use unsubscribe at server side.`);
  }

  /**
   * サーバー側では subscribe は実行できません。
   */
  subscribe() {
    throw new Error(`Can not use subscribe at server side.`);
  }

  /**
   * サーバー側では subscribeDocs は実行できません。
   */
  subscribeDocs() {
    throw new Error(`Can not use subscribeDocs at server side.`);
  }
}

export default ServerAdapter;
