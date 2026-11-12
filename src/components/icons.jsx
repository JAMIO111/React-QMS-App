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
  Plug as LucidePlug,
  ArrowRight as LucideArrowRight,
  Play as LucidePlay,
  ArrowUp as LucideArrowUp,
  ArrowUp01 as LucideArrowUp01,
  ArrowUp10 as LucideArrowUp10,
  ArrowUpDown as LucideArrowUpDown,
  ArrowUpNarrowWide as LucideArrowUpNarrowWide,
  ArrowUpZA as LucideArrowUpZA,
  AtSign as LucideAtSign,
  Ban as LucideBan,
  Bell as LucideBell,
  BellOff as LucideBellOff,
  AlarmClock as LucideAlarmClock,
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
  CircleX as LucideCircleX,
  CloudUpload as LucideCloudUpload,
  Columns3 as LucideColumns3,
  Database as LucideDatabase,
  Download as LucideDownload,
  FileDown as LucideFileDown,
  BookmarkPlus as LucideBookmarkPlus,
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
  LoaderCircle as LucideLoaderCircle,
  Package as LucidePackage,
  PanelLeftClose as LucidePanelLeftClose,
  PanelLeftOpen as LucidePanelLeftOpen,
  Pencil as LucidePencil,
  Plus as LucidePlus,
  PoundSterling as LucidePoundSterling,
  QrCode as LucideQrCode,
  RectangleEllipsis as LucideRectangleEllipsis,
  RefreshCw as LucideRefreshCw,
  RotateCcw as LucideRotateCcw,
  Archive as LucideArchive,
  Save as LucideSave,
  Printer as LucidePrinter,
  Route as LucideRoute,
  Search as LucideSearch,
  SearchCheck as LucideSearchCheck,
  Settings as LucideSettings,
  Share as LucideShare,
  ShieldCheck as LucideShieldCheck,
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
  User as LucideUser,
  Users as LucideUsers,
  X as LucideX,
  ArrowRightLeft as LucideArrowRightLeft,
  ClipboardList as LucideClipboardList,
  ChartNoAxesCombined as LucideChartNoAxesCombined,
  GraduationCap as LucideGraduationCap,
  ScanSearch as LucideScanSearch,
  Truck as LucideTruck,
  Factory as LucideFactory,
  Globe as LucideGlobe,
  KeyRound as LucideKeyRound,
  Power as LucidePower,
  FileText as LucideFileText,
  Hash as LucideHash,
  History as LucideHistory,
  Inbox as LucideInbox,
  Paperclip as LucidePaperclip,
  Receipt as LucideReceipt,
  CreditCard as LucideCreditCard,
  Tags as LucideTags,
  Building2 as LucideBuilding2,
  UserSearch as LucideUserSearch,
  CalendarPlus as LucideCalendarPlus,
  MapPin as LucideMapPin,
  Wrench as LucideWrench,
  Coins as LucideCoins,
  Image as LucideImage,
  Hourglass as LucideHourglass,
  Table as LucideTable,
  GripVertical as LucideGripVertical,
  Gauge as LucideGauge,
  Ruler as LucideRuler,
  ClipboardCheck as LucideClipboardCheck,
  ShieldAlert as LucideShieldAlert,
  CalendarClock as LucideCalendarClock,
  Handshake as LucideHandshake,
  Presentation as LucidePresentation,
  Target as LucideTarget,
  Sparkles as LucideSparkles,
  Clock as LucideClock,
  Thermometer as LucideThermometer,
  Droplets as LucideDroplets,
  FlaskConical as LucideFlaskConical,
  ChevronUp as LucideChevronUp,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  Link as LucideLink,
  ListChecks as LucideListChecks,
  ListTodo as LucideListTodo,
  Activity as LucideActivity,
  Bold as LucideBold,
  Italic as LucideItalic,
  Heading1 as LucideHeading1,
  Heading2 as LucideHeading2,
  Heading3 as LucideHeading3,
  ListOrdered as LucideListOrdered,
  Redo2 as LucideRedo2,
  FilePlus as LucideFilePlus,
  UserPlus as LucideUserPlus,
  MessageSquarePlus as LucideMessageSquarePlus,
} from "lucide-react";

const withDefaults = (Icon) => {
  const Wrapped = (props) => (
    <Icon
      size="1em"
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    />
  );
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
export const PlayIcon = withDefaults(LucidePlay);
export const ArrowUpIcon = withDefaults(LucideArrowUp);
export const ArrowUp01Icon = withDefaults(LucideArrowUp01);
export const ArrowUp10Icon = withDefaults(LucideArrowUp10);
export const ArrowUpDownIcon = withDefaults(LucideArrowUpDown);
export const ArrowUpNarrowWideIcon = withDefaults(LucideArrowUpNarrowWide);
export const ArrowUpZAIcon = withDefaults(LucideArrowUpZA);
export const AtSignIcon = withDefaults(LucideAtSign);
export const BanIcon = withDefaults(LucideBan);
export const BellIcon = withDefaults(LucideBell);
export const BellOffIcon = withDefaults(LucideBellOff);
export const AlarmClockIcon = withDefaults(LucideAlarmClock);
export const BoxIcon = withDefaults(LucideBox);
export const BoxesIcon = withDefaults(LucideBoxes);
export const CalendarIcon = withDefaults(LucideCalendar);
export const CheckIcon = withDefaults(LucideCheck);
export const ChevronDownIcon = withDefaults(LucideChevronDown);
export const ChevronsUpDownIcon = withDefaults(LucideChevronsUpDown);
export const CircleAlertIcon = withDefaults(LucideCircleAlert);
export const CircleCheckIcon = withDefaults(LucideCircleCheck);
export const CircleXIcon = withDefaults(LucideCircleX);
export const CircleDashedIcon = withDefaults(LucideCircleDashed);
export const CircleHelpIcon = withDefaults(LucideCircleHelp);
export const CircleUserIcon = withDefaults(LucideCircleUser);
export const CloudUploadIcon = withDefaults(LucideCloudUpload);
export const Columns3Icon = withDefaults(LucideColumns3);
export const DatabaseIcon = withDefaults(LucideDatabase);
export const DownloadIcon = withDefaults(LucideDownload);
export const FileDownIcon = withDefaults(LucideFileDown);
export const BookmarkPlusIcon = withDefaults(LucideBookmarkPlus);
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
export const PanelLeftCloseIcon = withDefaults(LucidePanelLeftClose);
export const PanelLeftOpenIcon = withDefaults(LucidePanelLeftOpen);
export const PencilIcon = withDefaults(LucidePencil);
export const LoaderCircleIcon = withDefaults(LucideLoaderCircle);
export const PlusIcon = withDefaults(LucidePlus);
export const PoundSterlingIcon = withDefaults(LucidePoundSterling);
export const QrCodeIcon = withDefaults(LucideQrCode);
export const RectangleEllipsisIcon = withDefaults(LucideRectangleEllipsis);
export const RefreshCwIcon = withDefaults(LucideRefreshCw);
export const RotateCcwIcon = withDefaults(LucideRotateCcw);
export const ArchiveIcon = withDefaults(LucideArchive);
export const SaveIcon = withDefaults(LucideSave);
export const PrinterIcon = withDefaults(LucidePrinter);
export const RouteIcon = withDefaults(LucideRoute);
export const SearchIcon = withDefaults(LucideSearch);
export const SearchCheckIcon = withDefaults(LucideSearchCheck);
export const SettingsIcon = withDefaults(LucideSettings);
export const ShareIcon = withDefaults(LucideShare);
export const ShieldCheckIcon = withDefaults(LucideShieldCheck);
export const PlugIcon = withDefaults(LucidePlug);
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
export const ArrowRightLeftIcon = withDefaults(LucideArrowRightLeft);
export const ClipboardListIcon = withDefaults(LucideClipboardList);
export const ChartNoAxesCombinedIcon = withDefaults(LucideChartNoAxesCombined);
export const ScanSearchIcon = withDefaults(LucideScanSearch);
export const TruckIcon = withDefaults(LucideTruck);
export const GraduationCapIcon = withDefaults(LucideGraduationCap);
export const FactoryIcon = withDefaults(LucideFactory);
export const GlobeIcon = withDefaults(LucideGlobe);
export const KeyRoundIcon = withDefaults(LucideKeyRound);
export const UserIcon = withDefaults(LucideUser);
export const PowerIcon = withDefaults(LucidePower);
export const FileTextIcon = withDefaults(LucideFileText);
export const HashIcon = withDefaults(LucideHash);
export const HistoryIcon = withDefaults(LucideHistory);
export const InboxIcon = withDefaults(LucideInbox);
export const ArrowRightIcon = withDefaults(LucideArrowRight);
export const PaperclipIcon = withDefaults(LucidePaperclip);
export const CreditCardIcon = withDefaults(LucideCreditCard);
export const ReceiptIcon = withDefaults(LucideReceipt);
export const TagsIcon = withDefaults(LucideTags);
export const BuildingIcon = withDefaults(LucideBuilding2);
export const UserSearchIcon = withDefaults(LucideUserSearch);
export const CalendarPlusIcon = withDefaults(LucideCalendarPlus);
export const MapPinIcon = withDefaults(LucideMapPin);
export const WrenchIcon = withDefaults(LucideWrench);
export const CoinsIcon = withDefaults(LucideCoins);
export const ImageIcon = withDefaults(LucideImage);
export const HourglassIcon = withDefaults(LucideHourglass);
export const TableIcon = withDefaults(LucideTable);
export const FilePlusIcon = withDefaults(LucideFilePlus);
export const UserPlusIcon = withDefaults(LucideUserPlus);
export const MessageSquarePlusIcon = withDefaults(LucideMessageSquarePlus);
export const BoldIcon = withDefaults(LucideBold);
export const ItalicIcon = withDefaults(LucideItalic);
export const Heading1Icon = withDefaults(LucideHeading1);
export const Heading2Icon = withDefaults(LucideHeading2);
export const Heading3Icon = withDefaults(LucideHeading3);
export const ListOrderedIcon = withDefaults(LucideListOrdered);
export const Redo2Icon = withDefaults(LucideRedo2);
export const GripVerticalIcon = withDefaults(LucideGripVertical);
export const GaugeIcon = withDefaults(LucideGauge);
export const RulerIcon = withDefaults(LucideRuler);
export const ClipboardCheckIcon = withDefaults(LucideClipboardCheck);
export const ShieldAlertIcon = withDefaults(LucideShieldAlert);
export const CalendarClockIcon = withDefaults(LucideCalendarClock);
export const HandshakeIcon = withDefaults(LucideHandshake);
export const PresentationIcon = withDefaults(LucidePresentation);
export const TargetIcon = withDefaults(LucideTarget);
export const SparklesIcon = withDefaults(LucideSparkles);
export const ClockIcon = withDefaults(LucideClock);
export const ThermometerIcon = withDefaults(LucideThermometer);
export const DropletsIcon = withDefaults(LucideDroplets);
export const FlaskConicalIcon = withDefaults(LucideFlaskConical);
export const ActivityIcon = withDefaults(LucideActivity);
export const ChevronUpIcon = withDefaults(LucideChevronUp);
export const ChevronLeftIcon = withDefaults(LucideChevronLeft);
export const ChevronRightIcon = withDefaults(LucideChevronRight);
export const LinkIcon = withDefaults(LucideLink);
export const ListChecksIcon = withDefaults(LucideListChecks);
export const ListTodoIcon = withDefaults(LucideListTodo);
