import { useState, useRef, useEffect } from "react";
import { IoCloudUploadOutline } from "react-icons/io5";
import { CgClose } from "react-icons/cg";
import { uploadFileToSupabase, saveFileMetadata } from "@/api/supabaseApi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import CTAButton from "../CTAButton";
import { TfiSave } from "react-icons/tfi";
import { IoIosUndo } from "react-icons/io";
import { useToast } from "@/contexts/ToastProvider";
import supabase from "../../supabase-client";
import DownloadLink from "./DownloadLink";
import { formatDate } from "../../lib/utils";
import { useUser } from "../../contexts/UserProvider";

const FileDrop = ({ ncm_id }) => {
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const [visibleFiles, setVisibleFiles] = useState([]); // already saved in DB
  const [newFiles, setNewFiles] = useState([]); // local File objects
  const [deletedFiles, setDeletedFiles] = useState([]); // for soft delete
  const [isSaving, setIsSaving] = useState(false);
  const { showToast } = useToast();
  const { profile } = useUser();
  const queryClient = useQueryClient();

  const fetchExistingFiles = async (ncm_id) => {
    const { data, error } = await supabase
      .from("v_nc_files")
      .select("*")
      .eq("id_ref", ncm_id);

    if (error) throw new Error(error.message);
    else return data;
  };

  const {
    data: existingFiles,
    error,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["NC Files", ncm_id],
    queryFn: () => fetchExistingFiles(ncm_id),
    enabled: !!ncm_id, // only run if ncm_id is provided
    staleTime: 5 * 60 * 1000, // optional: keeps cache "fresh" for 5 mins
    cacheTime: 15 * 60 * 1000, // optional: cache kept in memory for 10 mins
  });

  useEffect(() => {
    return () => {
      newFiles.forEach((file) => {
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      });
    };
  }, [newFiles]);

  useEffect(() => {
    if (existingFiles && existingFiles.length > 0) {
      setVisibleFiles(existingFiles);
    }
  }, [existingFiles]);

  const getSaveButtonText = () => {
    if (isSaving) return "Saving...";

    const hasUploads = newFiles.length > 0;
    const hasDeletions = deletedFiles.length > 0;

    if (hasUploads && hasDeletions) return "Save changes";
    if (hasUploads) return "Save uploads";
    if (hasDeletions) return "Save deletion";

    return "Save"; // fallback
  };

  const undoAllDeletions = () => {
    setVisibleFiles((prev) => [...prev, ...deletedFiles]);
    setDeletedFiles([]);
  };

  const handleSave = async () => {
    try {
      if (!ncm_id) throw new Error("Missing NCM ID");

      const didDelete = deletedFiles.length > 0;
      const didUpload = newFiles.length > 0;

      let deletedCount = 0;
      let uploadedCount = 0;

      setIsSaving(true);

      // DELETE FILES
      if (didDelete) {
        try {
          for (const file of deletedFiles) {
            const { error: deleteDbError } = await supabase
              .from("NC Files")
              .delete()
              .eq("id", file.id);
            if (deleteDbError) throw deleteDbError;

            const { error: deleteStorageError } = await supabase.storage
              .from("nc-files")
              .remove([file.path]);
            if (deleteStorageError) throw deleteStorageError;

            deletedCount++;
          }
        } catch (deleteError) {
          console.error("Error deleting files:", deleteError.message);
          showToast({
            type: "error",
            title: "Delete Failed",
            message: `An error occurred while deleting files: ${deleteError.message}`,
          });
          return;
        }
      }

      // UPLOAD FILES
      if (didUpload) {
        for (const file of newFiles) {
          try {
            const { path } = await uploadFileToSupabase(
              file,
              "nc-files",
              ncm_id
            );

            await saveFileMetadata(
              {
                file: file.file ?? file,
                path,
                id_ref: ncm_id,
                owner: profile.auth_id,
              },
              "NC Files"
            );

            uploadedCount++;
          } catch (fileError) {
            console.error(
              `Error uploading file: ${file.file.name}`,
              fileError.message
            );
            if (fileError.message.includes("The resource already exists")) {
              showToast({
                type: "error",
                title: "Upload Failed",
                message: `Failed to upload file "${file.file.name}": Duplicate file exists. Rename the file and try again.`,
              });
            } else {
              showToast({
                type: "error",
                title: "Upload Failed",
                message: `Failed to upload file "${file.file.name}": ${fileError.message}`,
              });
            }
          }
        }
      }

      // RESET
      setNewFiles([]);
      setDeletedFiles([]);
      await queryClient.invalidateQueries({
        queryKey: ["NC Files", ncm_id],
      });

      // SHOW TOASTS BASED ON SUCCESSFUL ACTIONS
      if (deletedCount && uploadedCount) {
        showToast({
          type: "success",
          title: "Upload Successful",
          message: `Uploaded ${uploadedCount} file(s) successfully.`,
        });
        setTimeout(() => {
          showToast({
            type: "success",
            title: "Delete Successful",
            message: `Deleted ${deletedCount} file(s) successfully.`,
          });
        }, 1000);
      } else if (deletedCount) {
        showToast({
          type: "success",
          title: "Delete Successful",
          message: `Deleted ${deletedCount} file(s) successfully.`,
        });
      } else if (uploadedCount) {
        showToast({
          type: "success",
          title: "Upload Successful",
          message: `Uploaded ${uploadedCount} file(s) successfully.`,
        });
      } else {
        showToast({
          type: "info",
          title: "No Changes",
          message: "No files were added or deleted.",
        });
      }
    } catch (error) {
      console.error("Unexpected error saving files:", error.message);
      showToast({
        type: "error",
        title: "Save Failed",
        message: `Unexpected error: ${error.message}`,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const dm = decimals;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  };

  const getFileIcon = (file) => {
    const extension = file.name.split(".").pop()?.toLowerCase();
    const [mainType, subType] = (file.type || "").split("/");
    if (!file.type)
      return (
        <img src="/icons/file-icon.png" alt="file" className="w-10 h-10" />
      );

    if (mainType === "video")
      return (
        <img src="/icons/video-icon.png" alt="video" className="w-10 h-10" />
      );
    if (mainType === "audio")
      return (
        <img src="/icons/audio-icon.png" alt="audio" className="w-10 h-10" />
      );
    if (mainType === "text" && extension !== "csv")
      return <img src="/icons/text.png" alt="text" className="w-10 h-10" />;

    switch (extension) {
      case "pdf":
        return (
          <img src="/icons/pdf-icon.svg" alt="PDF" className="w-10 h-10" />
        );
      case "doc":
      case "docx":
      case "docm":
      case "dotx":
        return (
          <img src="/icons/word-icon.png" alt="Word" className="w-10 h-10" />
        );
      case "xls":
      case "xlsx":
      case "xlsb":
      case "xlr":
      case "xlt":
      case "ods":
      case "csv":
      case "xlsm":
      case "xltx":
      case "xltm":
      case "xlam":
        return (
          <img src="/icons/excel-icon.png" alt="Excel" className="w-10 h-10" />
        );
      case "ppt":
      case "pptx":
      case "pptm":
      case "potx":
      case "potm":
      case "ppsx":
      case "ppsm":
      case "ppam":
      case "sldx":
      case "sldm":
      case "thmx":
        return (
          <img
            src="/icons/ppt-icon.png"
            alt="PowerPoint"
            className="w-10 h-10"
          />
        );
      default:
        return (
          <img src="/icons/file-icon.png" alt="File" className="w-10 h-10" />
        );
    }
  };

  const addFiles = (files) => {
    const MAX_FILE_SIZE_MB = 50;
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
    const validFiles = [];

    Array.from(files).forEach((file) => {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        showToast({
          type: "error",
          title: "File Too Large",
          message: `"${file.name}" exceeds the ${MAX_FILE_SIZE_MB}MB limit and was not added.`,
        });
        return;
      }

      const alreadyAdded = newFiles.some(
        (f) =>
          f.file.name === file.name &&
          f.file.size === file.size &&
          f.file.lastModified === file.lastModified
      );

      if (!alreadyAdded) {
        validFiles.push({
          file,
          previewUrl: URL.createObjectURL(file),
        });
      }
    });

    if (validFiles.length > 0) {
      setNewFiles((prev) => [...prev, ...validFiles]);
    }
  };

  const handleFileChange = (event) => {
    if (event.target.files) {
      addFiles(event.target.files);
      event.target.value = ""; // allows re-selection of same file
    }
  };

  // 📦 Handles file drop events
  const handleDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (event.dataTransfer.files) {
      addFiles(event.dataTransfer.files);
    }
  };

  // 🎯 Handles drag-over states for styling
  const handleDrag = (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.type === "dragenter" || event.type === "dragover") {
      setDragActive(true);
    } else if (event.type === "dragleave") {
      setDragActive(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 h-full w-full">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl text-primary-text font-semibold">
          File Upload
        </h2>
        <p className="text-secondary-text text-sm">
          Upload files and attachments to your claim here.
        </p>
      </div>
      <div
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current.click()}
        className="flex flex-col gap-5 py-10 items-center justify-center h-full w-full bg-secondary-bg border-2 border-dashed border-border-dark-color rounded-xl p-4 cursor-pointer hover:bg-primary-text/5 transition-colors">
        <IoCloudUploadOutline className="w-18 h-18 text-primary-text" />
        <div className="flex flex-col items-center gap-2">
          <span className="text-primary-text text-lg">
            Drag and drop files here or click to select
          </span>
          <span className="text-secondary-text">(Max file size 50MB)</span>
        </div>
        <input
          type="file"
          onChange={handleFileChange}
          ref={fileInputRef}
          hidden
          multiple
        />
      </div>
      <div className="flex flex-col gap-2 h-full w-full">
        <div className="flex flex-row justify-between items-center">
          <h3 className="text-lg text-primary-text">Files & Attachments</h3>
          <div className="flex gap-3">
            {deletedFiles.length > 0 && (
              <CTAButton
                width="w-36"
                text="Undo Delete"
                type="neutral"
                icon={IoIosUndo}
                callbackFn={undoAllDeletions}
              />
            )}
            {(newFiles.length > 0 || deletedFiles.length > 0) && (
              <CTAButton
                icon={TfiSave}
                iconSize="h-4 w-4"
                width="w-40"
                text={getSaveButtonText()}
                disabled={isSaving}
                type={
                  deletedFiles.length > 0 && newFiles.length === 0
                    ? "cancel"
                    : "success"
                }
                callbackFn={handleSave}
              />
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {isLoading ? (
            <div className="flex items-center justify-center h-full w-full p-4 bg-secondary-bg border-dashed border-2 border-border-dark-color rounded-lg">
              <p className="text-secondary-text">Loading files...</p>
            </div>
          ) : isError ? (
            <div className="flex items-center justify-center h-full w-full p-4 bg-secondary-bg border-dashed border-2 border-border-dark-color rounded-lg">
              <p className="text-error-color">
                Error loading files: {error.message}
              </p>
            </div>
          ) : newFiles.length + visibleFiles.length > 0 ? (
            <div className="border-dashed border-2 border-border-dark-color rounded-lg overflow-clip">
              <table className="w-full table-auto text-sm text-left text-secondary-text">
                <thead className="bg-primary-bg text-primary-text">
                  <tr>
                    <th className="px-2 py-2 text-center">Preview</th>
                    <th className="px-4 py-2">File Name</th>
                    <th className="px-4 py-2">Size</th>
                    <th className="px-4 py-2">Uploaded By</th>
                    <th className="px-4 py-2 w-10">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {[...newFiles, ...visibleFiles].map((f, idx) => {
                    const file = f.file ?? f;
                    const isImage = file.type?.startsWith("image/");
                    const previewUrl = f.previewUrl ?? file.url ?? null;
                    const uniqueKey = `${file.name}-${file.lastModified}-${file.size}`;

                    return (
                      <tr
                        key={uniqueKey}
                        className="border-t border-border-color hover:bg-primary-text/5">
                        <td>
                          <div className="flex items-center justify-center p-2">
                            {isImage ? (
                              <img
                                src={previewUrl || "/icons/image-icon.png"}
                                alt={file.name}
                                className={`rounded-md ${
                                  previewUrl
                                    ? "w-16 h-16 object-cover"
                                    : "w-10 h-10"
                                }`}
                                onLoad={() => {
                                  if (f.previewUrl)
                                    URL.revokeObjectURL(f.previewUrl);
                                }}
                              />
                            ) : (
                              <div className="mb-2">{getFileIcon(file)}</div>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-col gap-1.5 justify-center items-start">
                            {file.name}
                            {!file.id && (
                              <div className="text-xs text-gray-900 italic bg-warning-color/60 border border-warning-color py-0.5 px-1.5 rounded-md">
                                Unsaved File
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap">
                          {formatBytes(file.size)}
                        </td>
                        <td className="px-4 py-2">
                          {file.id ? (
                            <div className="flex flex-col gap-1.5">
                              <span>
                                {file.owner_first_name} {file.owner_surname}
                              </span>
                              <span className="text-xs text-secondary-text">
                                {formatDate(file.created_at, "ddd d mmm yyyy")}
                              </span>
                            </div>
                          ) : (
                            `${profile.first_name} ${profile.surname}`
                          )}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <div className="flex flex-row justify-center items-center gap-3">
                            <DownloadLink bucket="nc-files" file={file} />
                            <button
                              title="Remove"
                              className="text-error-color hover:bg-secondary-text/5 p-1.5 rounded-lg cursor-pointer"
                              onClick={() => {
                                if (f.id) {
                                  setDeletedFiles((prev) =>
                                    prev.find((x) => x.id === f.id)
                                      ? prev
                                      : [...prev, f]
                                  );
                                  setVisibleFiles((prev) =>
                                    prev.filter((x) => x.id !== f.id)
                                  );
                                } else {
                                  setNewFiles((prev) =>
                                    prev.filter((x) => x !== f)
                                  );
                                }
                              }}>
                              <CgClose className="w-5 h-5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full w-full p-4 bg-secondary-bg border-dashed border-2 border-border-dark-color rounded-lg">
              <p className="text-secondary-text">No files uploaded yet.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FileDrop;
