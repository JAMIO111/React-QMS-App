import { useQuery } from "@tanstack/react-query";
import { fetchAll } from "../api/supabaseApi";

export const usePropertyOptions = () => {
  return useQuery({
    queryKey: ["Properties"],
    queryFn: () => fetchAll("Properties"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
};

export const usePackageOptions = () => {
  return useQuery({
    queryKey: ["Packages"],
    queryFn: () => fetchAll("Packages"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
};

export const useFailureModeOptions = () => {
  return useQuery({
    queryKey: ["Failure Mode"],
    queryFn: () => fetchAll("Failure Mode"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
};

export const useSubFailureModeOptions = () => {
  return useQuery({
    queryKey: ["Sub-Failure Mode"],
    queryFn: () => fetchAll("Sub-Failure Mode"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
};

export const useProcessOptions = () => {
  return useQuery({
    queryKey: ["Process"],
    queryFn: () => fetchAll("Process"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
};

export const useEmployeesOptions = () => {
  return useQuery({
    queryKey: ["Employees"],
    queryFn: () => fetchAll("Employees"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
};
