import styles from "./LoadingSpinner.module.css";

const Spinner = () => (
  <div className="w-full h-full bg-primary-bg flex justify-center items-center">
    <div className={styles.spinnerContainer}>
      <div className={styles.spinner}></div>
      <div className={styles.loader}>
        <p>Loading</p>
        <div className={styles.words}>
          <span className={styles.word}>Dashboard</span>
          <span className={styles.word}>Non-conformances</span>
          <span className={styles.word}>Parts</span>
          <span className={styles.word}>Settings</span>
          <span className={styles.word}>Documents</span>
          <span className={styles.word}>Dashboard</span>
        </div>
      </div>
    </div>
  </div>
);

export default Spinner;
