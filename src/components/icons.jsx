/**
 * The app's icon set: Lucide only (https://lucide.dev). Import icons from here, not from
 * lucide-react directly, so they share defaults: size 1em (icons follow the surrounding text
 * size unless given size= or a width/height class) and currentColor.
 * To add an icon: import it below and export it as <Name>Icon via withDefaults().
 */
import {
  AlignCenter as LucideAlignCenter,
  ArrowDown as LucideArrowDown,
  ArrowDown10 as LucideArrowDown10,
  ArrowDownAZ as LucideArrowDownAZ,
  ArrowDownUp as LucideArrowDownUp,
  ArrowDownWideNarrow as LucideArrowDownWideNarrow,
  ArrowLeft as LucideArrowLeft,
  ArrowUp as LucideArrowUp,
  ArrowUp01 as LucideArrowUp01,
  ArrowUp10 as LucideArrowUp10,
  ArrowUpDown as LucideArrowUpDown,
  ArrowUpNarrowWide as LucideArrowUpNarrowWide,
  ArrowUpZA as LucideArrowUpZA,
  AtSign as LucideAtSign,
  Ban as LucideBan,
  Bell as LucideBell,
  Box as LucideBox,
  Boxes as LucideBoxes,
  Calendar as LucideCalendar,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronsUpDown as LucideChevronsUpDown,
  CircleAlert as LucideCircleAlert,
  CircleCheck as LucideCircleCheck,
  CircleDashed as LucideCircleDashed,
  CircleHelp as LucideCircleHelp,
  CircleUser as LucideCircleUser,
  CloudUpload as LucideCloudUpload,
  Columns3 as LucideColumns3,
  Database as LucideDatabase,
  Download as LucideDownload,
  Ellipsis as LucideEllipsis,
  EllipsisVertical as LucideEllipsisVertical,
  Eye as LucideEye,
  EyeOff as LucideEyeOff,
  FolderOpen as LucideFolderOpen,
  House as LucideHouse,
  Info as LucideInfo,
  Layers as LucideLayers,
  LayoutDashboard as LucideLayoutDashboard,
  LayoutGrid as LucideLayoutGrid,
  List as LucideList,
  Lock as LucideLock,
  LogOut as LucideLogOut,
  Mail as LucideMail,
  Minus as LucideMinus,
  MonitorCog as LucideMonitorCog,
  MoonStar as LucideMoonStar,
  Package as LucidePackage,
  PanelLeftOpen as LucidePanelLeftOpen,
  Pencil as LucidePencil,
  Plus as LucidePlus,
  PoundSterling as LucidePoundSterling,
  QrCode as LucideQrCode,
  RectangleEllipsis as LucideRectangleEllipsis,
  RefreshCw as LucideRefreshCw,
  RotateCcw as LucideRotateCcw,
  Save as LucideSave,
  Search as LucideSearch,
  Settings as LucideSettings,
  Share as LucideShare,
  ShieldUser as LucideShieldUser,
  SlidersHorizontal as LucideSlidersHorizontal,
  Sun as LucideSun,
  Tag as LucideTag,
  Trash2 as LucideTrash2,
  TrendingDown as LucideTrendingDown,
  TrendingUp as LucideTrendingUp,
  TriangleAlert as LucideTriangleAlert,
  Undo2 as LucideUndo2,
  Upload as LucideUpload,
  UserCog as LucideUserCog,
  Users as LucideUsers,
  X as LucideX,
} from "lucide-react";

const withDefaults = (Icon) => {
  const Wrapped = (props) => <Icon size="1em" aria-hidden={props["aria-label"] ? undefined : true} {...props} />;
  Wrapped.displayName = Icon.displayName;
  return Wrapped;
};

export const AlignCenterIcon = withDefaults(LucideAlignCenter);
export const ArrowDownIcon = withDefaults(LucideArrowDown);
export const ArrowDown10Icon = withDefaults(LucideArrowDown10);
export const ArrowDownAZIcon = withDefaults(LucideArrowDownAZ);
export const ArrowDownUpIcon = withDefaults(LucideArrowDownUp);
export const ArrowDownWideNarrowIcon = withDefaults(LucideArrowDownWideNarrow);
export const ArrowLeftIcon = withDefaults(LucideArrowLeft);
export const ArrowUpIcon = withDefaults(LucideArrowUp);
export const ArrowUp01Icon = withDefaults(LucideArrowUp01);
export const ArrowUp10Icon = withDefaults(LucideArrowUp10);
export const ArrowUpDownIcon = withDefaults(LucideArrowUpDown);
export const ArrowUpNarrowWideIcon = withDefaults(LucideArrowUpNarrowWide);
export const ArrowUpZAIcon = withDefaults(LucideArrowUpZA);
export const AtSignIcon = withDefaults(LucideAtSign);
export const BanIcon = withDefaults(LucideBan);
export const BellIcon = withDefaults(LucideBell);
export const BoxIcon = withDefaults(LucideBox);
export const BoxesIcon = withDefaults(LucideBoxes);
export const CalendarIcon = withDefaults(LucideCalendar);
export const CheckIcon = withDefaults(LucideCheck);
export const ChevronDownIcon = withDefaults(LucideChevronDown);
export const ChevronsUpDownIcon = withDefaults(LucideChevronsUpDown);
export const CircleAlertIcon = withDefaults(LucideCircleAlert);
export const CircleCheckIcon = withDefaults(LucideCircleCheck);
export const CircleDashedIcon = withDefaults(LucideCircleDashed);
export const CircleHelpIcon = withDefaults(LucideCircleHelp);
export const CircleUserIcon = withDefaults(LucideCircleUser);
export const CloudUploadIcon = withDefaults(LucideCloudUpload);
export const Columns3Icon = withDefaults(LucideColumns3);
export const DatabaseIcon = withDefaults(LucideDatabase);
export const DownloadIcon = withDefaults(LucideDownload);
export const EllipsisIcon = withDefaults(LucideEllipsis);
export const EllipsisVerticalIcon = withDefaults(LucideEllipsisVertical);
export const EyeIcon = withDefaults(LucideEye);
export const EyeOffIcon = withDefaults(LucideEyeOff);
export const FolderOpenIcon = withDefaults(LucideFolderOpen);
export const HouseIcon = withDefaults(LucideHouse);
export const InfoIcon = withDefaults(LucideInfo);
export const LayersIcon = withDefaults(LucideLayers);
export const LayoutDashboardIcon = withDefaults(LucideLayoutDashboard);
export const LayoutGridIcon = withDefaults(LucideLayoutGrid);
export const ListIcon = withDefaults(LucideList);
export const LockIcon = withDefaults(LucideLock);
export const LogOutIcon = withDefaults(LucideLogOut);
export const MailIcon = withDefaults(LucideMail);
export const MinusIcon = withDefaults(LucideMinus);
export const MonitorCogIcon = withDefaults(LucideMonitorCog);
export const MoonStarIcon = withDefaults(LucideMoonStar);
export const PackageIcon = withDefaults(LucidePackage);
export const PanelLeftOpenIcon = withDefaults(LucidePanelLeftOpen);
export const PencilIcon = withDefaults(LucidePencil);
export const PlusIcon = withDefaults(LucidePlus);
export const PoundSterlingIcon = withDefaults(LucidePoundSterling);
export const QrCodeIcon = withDefaults(LucideQrCode);
export const RectangleEllipsisIcon = withDefaults(LucideRectangleEllipsis);
export const RefreshCwIcon = withDefaults(LucideRefreshCw);
export const RotateCcwIcon = withDefaults(LucideRotateCcw);
export const SaveIcon = withDefaults(LucideSave);
export const SearchIcon = withDefaults(LucideSearch);
export const SettingsIcon = withDefaults(LucideSettings);
export const ShareIcon = withDefaults(LucideShare);
export const ShieldUserIcon = withDefaults(LucideShieldUser);
export const SlidersHorizontalIcon = withDefaults(LucideSlidersHorizontal);
export const SunIcon = withDefaults(LucideSun);
export const TagIcon = withDefaults(LucideTag);
export const Trash2Icon = withDefaults(LucideTrash2);
export const TrendingDownIcon = withDefaults(LucideTrendingDown);
export const TrendingUpIcon = withDefaults(LucideTrendingUp);
export const TriangleAlertIcon = withDefaults(LucideTriangleAlert);
export const Undo2Icon = withDefaults(LucideUndo2);
export const UploadIcon = withDefaults(LucideUpload);
export const UserCogIcon = withDefaults(LucideUserCog);
export const UsersIcon = withDefaults(LucideUsers);
export const XIcon = withDefaults(LucideX);
