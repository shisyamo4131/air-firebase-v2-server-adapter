/**
 * サーバー側で使用する FireModel のアダプターです。
 * FireModel に Firestore に対する CRUD 機能を注入します。
 */
import { logger } from "firebase-functions";

class ServerAdapter {
  static firestore = null;

  constructor(firestore) {
    ServerAdapter.firestore = firestore;
  }

  /**
   * console を返します。
   * FireModel でコンソールを出力するために使用します。
   */
  get logger() {
    return logger;
  }

  async setAutonumber({ transaction, prefix = null }) {
    if (!transaction) {
      throw new Error("transaction is required.");
    }

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      const docRef = ServerAdapter.firestore
        .collection("Autonumbers")
        .doc(collectionPath);

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

      const newNumber = data.current + 1;
      const length = data.length;
      const maxValue = Math.pow(10, length) - 1;

      if (newNumber > maxValue) {
        throw new Error(
          `The maximum value for Autonumber has been reached. collection: ${collectionPath}`
        );
      }

      const newCode = String(newNumber).padStart(length, "0");
      this[data.field] = newCode;

      return () => transaction.update(docRef, { current: newNumber });
    } catch (err) {
      console.error(`[ServerAdapter.js - setAutonumber]`, err);
      throw err;
    }
  }

  /**
   * Creates a document in Firestore with the current instance data.
   * - Executed within a transaction. If not provided, one will be created internally.
   * - If `docId` is not provided, Firestore auto-generates one.
   * - If `useAutonumber` is `true` and the model supports it, auto-numbering will run.
   * - If `callBack` is provided, it will be executed after the document is created.
   * - If `prefix` is provided, it will be used to resolve the collection path.
   *
   * Firestore に現在のインスタンスデータでドキュメントを作成します。
   * - 処理はトランザクション内で実行され、指定がない場合は内部で生成されます。
   * - `docId` が指定されていなければ Firestore により自動生成されます。
   * - モデルが自動採番に対応しており、`useAutonumber` が `true` の場合は採番処理が行われます。
   * - `callBack` が指定されていれば、作成後に実行されます。
   * - `prefix` が指定されていれば、コレクションパスの解決に使用されます。
   *
   * @param {Object} args - Parameters for document creation.
   * @param {string|null} [args.docId] - Optional document ID.
   * @param {boolean} [args.useAutonumber=true] - Whether to use auto-numbering.
   * @param {Object|null} [args.transaction] - Firestore transaction object.
   * @param {function|null} [args.callBack] - Optional callback after creation.
   * @param {string|null} [args.prefix] - Optional Firestore path prefix.
   * @returns {Promise<DocumentReference>} Reference to the created document.
   * @throws {Error} If callback is invalid or Firestore operation fails.
   */
  async create({
    docId = null,
    useAutonumber = true,
    transaction = null,
    callBack = null,
    prefix = null,
  }) {
    if (callBack !== null && typeof callBack !== "function") {
      throw new Error(`callBack must be a function.`);
    }

    try {
      await this.beforeCreate();
      this.validate();

      const performTransaction = async (txn) => {
        const updateAutonumber =
          this.constructor.useAutonumber && useAutonumber
            ? await this.setAutonumber({ transaction: txn, prefix })
            : null;

        const collectionPath = this.constructor.getCollectionPath(prefix);
        const colRef = ServerAdapter.firestore
          .collection(collectionPath)
          .withConverter(this.constructor.converter());

        const docRef = docId ? colRef.doc(docId) : colRef.doc();

        this.docId = docRef.id;
        this.createdAt = new Date();
        this.updatedAt = new Date();
        this.uid = "cloud functions";

        txn.set(docRef, this);
        if (updateAutonumber) await updateAutonumber();
        if (callBack) await callBack(txn);
        return docRef;
      };

      const docRef = transaction
        ? await performTransaction(transaction)
        : await ServerAdapter.firestore.runTransaction(performTransaction);

      return docRef;
    } catch (err) {
      console.error(`[ServerAdapter.js - create] An error has occurred.`, err);
      throw err;
    }
  }

  async fetch({ docId, transaction = null, prefix = null }) {
    if (!docId) throw new Error("docId is required.");

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = ServerAdapter.firestore
        .collection(collectionPath)
        .withConverter(this.constructor.converter());
      const docRef = colRef.doc(docId);

      const docSnap = transaction
        ? await transaction.get(docRef)
        : await docRef.get();

      this.initialize(docSnap.exists ? docSnap.data() : null);

      return docSnap.exists;
    } catch (err) {
      console.error(`[ServerAdapter.js - fetch]`, err);
      throw err;
    }
  }

  async fetchDoc({ docId, transaction = null, prefix = null }) {
    if (!docId) throw new Error("docId is required.");

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = ServerAdapter.firestore
        .collection(collectionPath)
        .withConverter(this.constructor.converter());
      const docRef = colRef.doc(docId);

      const docSnap = transaction
        ? await transaction.get(docRef)
        : await docRef.get();

      return docSnap.exists ? docSnap.data() : null;
    } catch (err) {
      console.error(`[ServerAdapter.js - fetchDoc]`, err);
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

  async fetchDocs({
    constraints = [],
    options = [],
    transaction = null,
    prefix = null,
  }) {
    const queryConstraints = [];

    if (!Array.isArray(constraints)) {
      throw new Error(`constraints must be an array.`);
    }

    if (!Array.isArray(options)) {
      throw new Error(`options must be an array.`);
    }

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = ServerAdapter.firestore
        .collection(collectionPath)
        .withConverter(this.constructor.converter());

      let queryRef = colRef;

      [...constraints, ...options].forEach(([type, ...args]) => {
        switch (type) {
          case "where":
            queryRef = queryRef.where(...args);
            break;
          case "orderBy":
            queryRef = queryRef.orderBy(args[0], args[1] || "asc");
            break;
          case "limit":
            queryRef = queryRef.limit(args[0]);
            break;
          default:
            throw new Error(`Invalid query type: ${type}`);
        }
      });

      const snapshot = transaction
        ? await transaction.get(queryRef)
        : await queryRef.get();

      return snapshot.docs.map((doc) => doc.data());
    } catch (err) {
      console.error(`[ServerAdapter.js - fetchDocs]`, err);
      throw err;
    }
  }

  /**
   * Updates the Firestore document with the current instance data.
   * - Requires `this.docId` to be set (usually after calling `fetch()`).
   * - Runs within a transaction. If not provided, one is created internally.
   * - If `callBack` is provided, it will be executed after the update.
   * - If `prefix` is provided, it is used to resolve the collection path.
   *
   * 現在のインスタンスデータで Firestore のドキュメントを更新します。
   * - `this.docId` が設定されていない場合はエラーになります（通常は `fetch()` を事前に実行）。
   * - 更新処理はトランザクション内で行われ、未指定の場合は内部で生成されます。
   * - `callBack` が指定されている場合は、更新後に実行されます。
   * - `prefix` が指定されていれば、コレクションパスの解決に使用されます。
   *
   * @param {Object} args - Parameters for update.
   * @param {Object|null} [args.transaction=null] - Firestore transaction object.
   * @param {function|null} [args.callBack=null] - Callback function after update.
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   * @returns {Promise<DocumentReference>} Reference to the updated document.
   * @throws {Error} If `docId` is not set or update fails.
   */
  async update({ transaction = null, callBack = null, prefix = null } = {}) {
    if (callBack !== null && typeof callBack !== "function") {
      throw new Error(`callBack must be a function.`);
    }

    if (!this.docId) {
      throw new Error(
        `The docId property is required for update(). Call fetch() first.`
      );
    }

    try {
      await this.beforeUpdate();
      this.validate();

      const performTransaction = async (txn) => {
        const collectionPath = this.constructor.getCollectionPath(prefix);
        const colRef = ServerAdapter.firestore
          .collection(collectionPath)
          .withConverter(this.constructor.converter());
        const docRef = colRef.doc(this.docId);

        this.updatedAt = new Date();
        this.uid = "cloud functions";

        txn.set(docRef, this);
        if (callBack) await callBack(txn);
        return docRef;
      };

      const docRef = transaction
        ? await performTransaction(transaction)
        : await ServerAdapter.firestore.runTransaction(performTransaction);

      return docRef;
    } catch (err) {
      console.error(`[ServerAdapter.js - update] An error has occurred.`);
      throw err;
    }
  }

  async hasChild({ transaction = null, prefix = null } = {}) {
    if (!this.docId) {
      throw new Error(`The docId property is required. Call fetch() first.`);
    }

    try {
      for (const item of this.constructor.hasMany) {
        const collectionPath =
          item.type === "collection" && prefix
            ? `${prefix}/${item.collection}`.replace(/^\/|\/$/g, "")
            : item.collection;

        const colRef =
          item.type === "collection"
            ? ServerAdapter.firestore.collection(collectionPath)
            : ServerAdapter.firestore.collectionGroup(item.collection);

        const queryRef = colRef
          .where(item.field, item.condition, this.docId)
          .limit(1);

        const snapshot = transaction
          ? await transaction.get(queryRef)
          : await queryRef.get();

        if (!snapshot.empty) return item;
      }

      return false;
    } catch (err) {
      console.error(`[ServerAdapter.js - hasChild]`, err);
      throw err;
    }
  }

  /**
   * Deletes the document with the current `docId` from Firestore.
   * - If `logicalDelete` is enabled, moves the document to an archive collection instead of permanent deletion.
   * - Runs within a transaction. If not provided, a new one is created internally.
   * - If `callBack` is provided, it is executed after deletion.
   * - If `prefix` is provided, it is used to resolve the collection path.
   *
   * 現在の `docId` を持つドキュメントを Firestore から削除します。
   * - `logicalDelete` が有効な場合は、物理削除せずアーカイブコレクションに移動します。
   * - トランザクション内で実行され、指定がなければ内部で作成されます。
   * - `callBack` が指定されていれば、削除後に実行されます。
   * - `prefix` が指定されていれば、コレクションパスの解決に使用されます。
   *
   * @param {Object} args - Deletion options.
   * @param {Object|null} [args.transaction=null] - Firestore transaction object.
   * @param {function|null} [args.callBack=null] - Callback to execute after deletion.
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   * @returns {Promise<void>} Resolves when deletion is complete.
   * @throws {Error} If `docId` is missing, or the document can't be deleted.
   */
  async delete({ transaction = null, callBack = null, prefix = null } = {}) {
    if (callBack !== null && typeof callBack !== "function") {
      throw new Error(`callBack must be a function.`);
    }

    if (!this.docId) {
      throw new Error(
        `The docId property is required for delete(). Call fetch() first.`
      );
    }

    try {
      await this.beforeDelete();

      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = ServerAdapter.firestore.collection(collectionPath);
      const docRef = colRef.doc(this.docId);

      const performTransaction = async (txn) => {
        const hasChild = await this.hasChild({ transaction: txn, prefix });
        if (hasChild) {
          throw new Error(
            `Cannot delete because the associated document exists in the ${hasChild.collection} collection.`
          );
        }

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

        txn.delete(docRef);
        if (callBack) await callBack(txn);
      };

      if (transaction) {
        await performTransaction(transaction);
      } else {
        await ServerAdapter.firestore.runTransaction(performTransaction);
      }
    } catch (err) {
      console.error(`[ServerAdapter.js - delete] An error has occurred.`);
      throw err;
    }
  }

  async restore({ docId, prefix = null }) {
    if (!docId) throw new Error("docId is required.");

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      const archivePath = `${collectionPath}_archive`;

      const archiveColRef = ServerAdapter.firestore.collection(archivePath);
      const archiveDocRef = archiveColRef.doc(docId);
      const docSnapshot = await archiveDocRef.get();

      if (!docSnapshot.exists) {
        throw new Error(
          `Archived document not found at ${archivePath}. docId: ${docId}`
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
      console.error(`[ServerAdapter.js - restore]`, err);
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
