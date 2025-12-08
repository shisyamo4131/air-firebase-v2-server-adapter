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

  get type() {
    return "SERVER";
  }

  /**
   * console を返します。
   * FireModel でコンソールを出力するために使用します。
   */
  get logger() {
    return logger;
  }

  async setAutonumber({ transaction, prefix = null } = {}) {
    if (!transaction) {
      throw new Error("transaction is required.");
    }

    if (!prefix) {
      throw new Error("prefix is required.");
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

  // /**
  //  * Returns a function to update the counter document in Firestore.
  //  * - This function treats 'this' as a FireModel instance.
  //  * @param {Object} args - Parameters for counter update.
  //  * @param {Object} args.transaction - Firestore transaction object (required).
  //  * @param {boolean} [args.increment=true] - Whether to increment (true) or decrement (false) the counter.
  //  * @param {string|null} [args.prefix=null] - Optional path prefix for collection.
  //  * @returns {Promise<Function>} Function to update the counter document.
  //  */
  // async getCounterUpdater(args = {}) {
  //   const { transaction, increment = true, prefix = null } = args;
  //   // transaction is required
  //   if (!transaction) {
  //     throw new Error(
  //       "[ServerAdapter - getCounterUpdater] transaction is required."
  //     );
  //   }

  //   // Get collection path defined by class.
  //   // -> `getCollectionPath()` is a static method defined in FireModel.
  //   // ex) `customers` or `companies/{companyId}/customers`
  //   const collectionPath = this.constructor.getCollectionPath(prefix);

  //   // Divide collection path into segments.
  //   // ex) `["companies", "{companyId}", "customers"]`
  //   const segments = collectionPath.split("/");

  //   // Get collection name (Last segment is collection name)
  //   const colName = segments.pop();

  //   // Determine effective collection path for counter-document.
  //   const effectiveDocPath = `${segments.join("/")}/meta/docCounter`;
  //   const docRef = ServerAdapter.firestore.doc(effectiveDocPath);
  //   const docSnap = await transaction.get(docRef);
  //   if (!docSnap.exists) {
  //     return () => transaction.set(docRef, { [colName]: increment ? 1 : 0 });
  //   } else {
  //     return () =>
  //       transaction.update(docRef, {
  //         [colName]: ServerAdapter.firestore.FieldValue.increment(
  //           increment ? 1 : -1
  //         ),
  //       });
  //   }
  // }

  /**
   * Create a new document in Firestore.
   * @param {Object} args - Creation options.
   * @param {string} [args.docId] - Document ID to use (optional).
   * @param {boolean} [args.useAutonumber=true] - Whether to use auto-numbering.
   * @param {Object} [args.transaction] - Firestore transaction.
   * @param {Function} [args.callBack] - Callback function.
   * @param {string} [args.prefix] - Path prefix.
   * @returns {Promise<DocumentReference>} Reference to the created document.
   * @throws {Error} If creation fails or `callBack` is not a function.
   */
  async create(args = {}) {
    const { docId, useAutonumber = true, transaction, callBack, prefix } = args;

    try {
      // `callBack` must be a function if provided.
      if (callBack && typeof callBack !== "function") {
        throw new Error(
          `[ServerAdapter.js - create] callBack must be a function.`
        );
      }

      // Pre-create hooks and validation
      await this.beforeCreate(args);
      await this.beforeEdit(args);
      this.validate();

      // transaction processing
      const performTransaction = async (txn) => {
        // Get function to update autonumber if `useAutonumber` is true.
        const updateAutonumber =
          this.constructor.useAutonumber && useAutonumber
            ? await this.setAutonumber({ transaction: txn, prefix })
            : null;

        // Get function to update counter document.
        // const adapter = this.constructor.getAdapter();
        // const counterUpdater = await adapter.getCounterUpdater.bind(this)({
        //   transaction: txn,
        //   increment: true,
        //   prefix,
        // });

        // Prepare document reference
        const collectionPath = this.constructor.getCollectionPath(prefix);
        const colRef = ServerAdapter.firestore
          .collection(collectionPath)
          .withConverter(this.constructor.converter());
        const docRef = docId ? colRef.doc(docId) : colRef.doc();

        // Set metadata
        this.docId = docRef.id;
        this.createdAt = new Date();
        this.updatedAt = new Date();
        this.uid = "cloud functions";

        // Create document
        txn.set(docRef, this);

        // Update autonumber if applicable
        if (updateAutonumber) await updateAutonumber();

        // if (counterUpdater) await counterUpdater();

        // Execute callback if provided
        if (callBack) await callBack(txn);

        // Return document reference
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

  /**
   * Get a document from Firestore by its ID and load into this instance.
   * - The class properties will be cleared if the document does not exist.
   * @param {Object} args - Fetch options.
   * @param {string} args.docId - Document ID to fetch.
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Path prefix (optional).
   * @returns {Promise<boolean>} True if document was found and loaded, false if not found.
   * @throws {Error} If `docId` is not specified or fetch fails.
   */
  async fetch(args = {}) {
    const { docId, transaction = null, prefix = null } = args;
    try {
      if (!docId) {
        throw new Error("[ServerAdapter.js - fetch] docId is required.");
      }

      // Get collection path defined by FireModel.
      const collectionPath = this.constructor.getCollectionPath(prefix);

      // Prepare document reference.
      const colRef = ServerAdapter.firestore
        .collection(collectionPath)
        .withConverter(this.constructor.converter());
      const docRef = colRef.doc(docId);

      // Fetch document snapshot.
      const docSnap = transaction
        ? await transaction.get(docRef)
        : await docRef.get();

      // Load data into this instance, or reset if not found.
      this.initialize(docSnap.exists ? docSnap.data() : null);

      return docSnap.exists;
    } catch (err) {
      console.error(`[ServerAdapter.js - fetch]`, err);
      throw err;
    }
  }

  /**
   * Get a document from Firestore by its ID and return as a new instance.
   * @param {Object} args - Fetch options.
   * @param {string} args.docId - Document ID to fetch.
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Path prefix (optional).
   * @returns {Promise<Object|null>} Document data, or null if not found.
   * @throws {Error} If `docId` is not specified or fetch fails.
   */
  async fetchDoc(args = {}) {
    try {
      const { docId, transaction = null, prefix = null } = args;

      // Throw error if docId is not provided.
      if (!docId) {
        throw new Error("[ServerAdapter.js - fetchDoc] 'docId' is required.");
      }

      // Get collection path defined by FireModel.
      const collectionPath = this.constructor.getCollectionPath(prefix);

      // Prepare document reference.
      const colRef = ServerAdapter.firestore
        .collection(collectionPath)
        .withConverter(this.constructor.converter());
      const docRef = colRef.doc(docId);

      // Fetch document snapshot.
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

  async fetchDocs({
    constraints = [],
    options = [],
    transaction = null,
    prefix = null,
  } = {}) {
    try {
      if (!Array.isArray(constraints)) {
        throw new Error(`constraints must be an array.`);
      }

      if (!Array.isArray(options)) {
        throw new Error(`options must be an array.`);
      }

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
    try {
      if (callBack !== null && typeof callBack !== "function") {
        throw new Error(`callBack must be a function.`);
      }

      if (!this.docId) {
        throw new Error(
          `The docId property is required for update(). Call fetch() first.`
        );
      }

      await this.beforeUpdate(args);
      await this.beforeEdit(args);
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

  /**
   * Checks if any child documents exist for this document, based on `hasMany` configuration.
   * - For collections, the prefix is applied to the collection path.
   *
   * [NOTE]
   * - 2025/10/06 現在、transaction.get() に Query を指定することはできない仕様。
   *   そのため、依存ドキュメントの存在確認には getDocs() を使用することになるが、
   *   transaction 内での読み取りにならず、当該処理の直後に他のプロセスから依存ドキュメントが
   *   追加された場合に整合性を失う可能性あり。
   *   引数 transaction が本来であれば不要だが、将来的に transaction.get() が
   *   Query に対応した場合に備えて引数として受け取る形にしておく。
   *
   * @param {Object} args - Options for the check.
   * @param {Object|null} [args.transaction=null] - Firestore transaction object (optional).
   * @param {string|null} [args.prefix=null] - Optional path prefix for resolving collections.
   * @returns {Promise<object|boolean>} Matching `hasMany` item if found, otherwise false.
   * @throws {Error} If `docId` is not set or query fails.
   */
  async hasChild({ transaction = null, prefix = null } = {}) {
    try {
      if (!this.docId) {
        throw new Error(`The docId property is required. Call fetch() first.`);
      }

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

        /** transaction.get() が Query に対応した場合は以下をコメントアウト */
        const snapshot = await queryRef.get();

        /** transaction.get() が Query に対応した場合は以下を使用 */
        // const snapshot = transaction
        //   ? await transaction.get(queryRef)
        //   : await queryRef.get();

        if (!snapshot.empty) return item;
      }

      return false;
    } catch (error) {
      console.error(`[ServerAdapter.js - hasChild] ${error.message}`, error);
      throw error;
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
    try {
      if (callBack !== null && typeof callBack !== "function") {
        throw new Error(`callBack must be a function.`);
      }

      if (!this.docId) {
        throw new Error(
          `The docId property is required for delete(). Call fetch() first.`
        );
      }
      await this.beforeDelete(args);

      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = ServerAdapter.firestore.collection(collectionPath);
      const docRef = colRef.doc(this.docId);

      const performTransaction = async (txn) => {
        // Check for child documents before deletion
        // If child documents exist, throw an error to prevent deletion
        const hasChild = await this.hasChild({ transaction: txn, prefix });
        if (hasChild) {
          throw new Error(
            `Cannot delete because the associated document exists in the ${hasChild.collection} collection.`
          );
        }

        // Get function to update counter document.
        // const adapter = this.constructor.getAdapter();
        // const counterUpdater = await adapter.getCounterUpdater.bind(this)({
        //   transaction: txn,
        //   increment: false,
        //   prefix,
        // });

        // If logicalDelete is enabled, archive the document before deletion
        if (this.constructor.logicalDelete) {
          // Fetch the document to be deleted
          // This is necessary because in a transaction, docRef.get() cannot be used directly
          // and we need to ensure the document exists before archiving
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

        // if (counterUpdater) await counterUpdater();

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

  async restore({ docId, prefix = null, transaction = null } = {}) {
    try {
      if (!docId) throw new Error("docId is required.");

      const performTransaction = async (txn) => {
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

        // Get function to update counter document.
        // const adapter = this.constructor.getAdapter();
        // const counterUpdater = await adapter.getCounterUpdater.bind(this)({
        //   transaction: txn,
        //   increment: true,
        //   prefix,
        // });

        const colRef = ServerAdapter.firestore.collection(collectionPath);
        const docRef = colRef.doc(docId);
        txn.delete(archiveDocRef);
        txn.set(docRef, docSnapshot.data());

        // if (counterUpdater) await counterUpdater();

        return docRef;
      };

      if (transaction) {
        return await performTransaction(transaction);
      } else {
        return await ServerAdapter.firestore.runTransaction(performTransaction);
      }
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

  /**
   * Firestore トランザクションを実行します。
   * @param {Function} updateFunction - トランザクション内で実行する関数
   * @returns {Promise<any>} トランザクションの結果
   */
  async runTransaction(updateFunction) {
    return await this.constructor.firestore.runTransaction(updateFunction);
  }
}

export default ServerAdapter;
