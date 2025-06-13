import styles from "./LoadingSpinner.module.css";

const Spinner = () => (
  <div className={styles.spinnerContainer}>
    <div className={styles.spinner}></div>
    <div className={styles.loader}>
      <p>Loading</p>
      <div className={styles.words}>
        <span className={styles.word}>Documents</span>
        <span className={styles.word}>Dashboard</span>
        <span className={styles.word}>Projects</span>
        <span className={styles.word}>Actions</span>
        <span className={styles.word}>Documents</span>
        <span className={styles.word}>Documents</span>
      </div>
    </div>
  </div>
);

export default Spinner;
