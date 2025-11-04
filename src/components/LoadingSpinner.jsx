import styles from "./LoadingSpinner.module.css";

const Spinner = () => (
  <div className="w=full h-full bg-primary-bg flex justify-center items-center">
    <div className={styles.spinnerContainer}>
      <div className={styles.spinner}></div>
      <div className={styles.loader}>
        <p>Loading</p>
        <div className={styles.words}>
          <span className={styles.word}>Bookings</span>
          <span className={styles.word}>Properties</span>
          <span className={styles.word}>Owners</span>
          <span className={styles.word}>Dashboard</span>
          <span className={styles.word}>Documents</span>
          <span className={styles.word}>Documents</span>
        </div>
      </div>
    </div>
  </div>
);

export default Spinner;
