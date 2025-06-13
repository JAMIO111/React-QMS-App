import { useState } from "react";
import { generateSignedUrl } from "../../api/supabaseApi";
import { LuDownload } from "react-icons/lu";

function DownloadLink({ bucket, file }) {
  const [signedUrl, setSignedUrl] = useState(null);
  const [loading, setLoading] = useState(false);

  const filePath = file.id ? file.path : undefined;

  const handleClick = async (e) => {
    e.preventDefault(); // prevent immediate navigation

    if (file.id) {
      // If file has an ID, we need to generate a signed URL
      if (loading) return; // prevent multiple clicks while loading

      if (!signedUrl) {
        setLoading(true);
        const url = await generateSignedUrl(bucket, filePath);
        setSignedUrl(url);
        setLoading(false);

        if (url) {
          // open the link after generating signed URL
          window.open(url, "_blank");
        }
      } else {
        // URL already generated, just open it
        window.open(signedUrl, "_blank");
      }
    } else {
      const previewUrl =
        file.previewUrl || URL.createObjectURL(file.file ?? file);
      // If file does not have an ID, use the preview URL directly
      window.open(previewUrl, "_blank");
    }
  };

  return (
    <a
      href="#"
      aria-label="Download file"
      disabled={loading}
      onClick={handleClick}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:bg-secondary-text/5 p-1.5 rounded-lg cursor-pointer"
      title="Download">
      <LuDownload className="w-5 h-5 text-primary-text" />
    </a>
  );
}

export default DownloadLink;
