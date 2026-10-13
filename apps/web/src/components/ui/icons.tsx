import { forwardRef } from "react";
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";
import {
  AlertTriangle as AlertTriangleSvg,
  Archive02Icon,
  ArrowLeft as ArrowLeftSvg,
  ArrowRight as ArrowRightSvg,
  ArrowUpRight as ArrowUpRightSvg,
  AtSign as AtSignSvg,
  Bell as BellSvg,
  BellRing as BellRingSvg,
  BellOff as BellOffSvg,
  BookOpenText as BookOpenTextSvg,
  Bookmark as BookmarkSvg,
  CalendarDays as CalendarDaysSvg,
  Check as CheckSvg,
  CheckCheck as CheckCheckSvg,
  CheckmarkSquare02Icon,
  ChevronDown as ChevronDownSvg,
  ChevronLeft as ChevronLeftSvg,
  ChevronRight as ChevronRightSvg,
  CircleAlert as CircleAlertSvg,
  Clock3 as Clock3Svg,
  Columns3 as Columns3Svg,
  Copy as CopySvg,
  Database as DatabaseSvg,
  Download as DownloadSvg,
  Edit02Icon,
  Eye as EyeSvg,
  FilePlusIcon,
  FileQuestionMarkIcon,
  FileText as FileTextSvg,
  Filter as FilterSvg,
  Focus as FocusSvg,
  FolderOpen as FolderOpenSvg,
  Hash as HashSvg,
  Home as HomeSvg,
  Info as InfoSvg,
  KeyRound as KeyRoundSvg,
  Layers01Icon,
  LayoutDashboard as LayoutDashboardSvg,
  ListTodo as ListTodoSvg,
  LockKeyhole as LockKeyholeSvg,
  LogOut as LogOutSvg,
  Mail as MailSvg,
  MailCheck as MailCheckSvg,
  Menu as MenuSvg,
  Moon as MoonSvg,
  MessageCircle as MessageCircleSvg,
  MessageSquareText as MessageSquareTextSvg,
  MoreHorizontal as MoreHorizontalSvg,
  PanelLeftClose as PanelLeftCloseSvg,
  PanelLeftOpen as PanelLeftOpenSvg,
  Paperclip as PaperclipSvg,
  Pause as PauseSvg,
  Pin as PinSvg,
  Play as PlaySvg,
  Plus as PlusSvg,
  RefreshCw as RefreshCwSvg,
  Undo02Icon,
  ArrowTurnBackwardIcon,
  Scale as ScaleSvg,
  Search as SearchSvg,
  Send as SendSvg,
  Settings as SettingsSvg,
  ShieldCheck as ShieldCheckSvg,
  SmilePlus as SmilePlusSvg,
  Sparkles as SparklesSvg,
  Square as SquareSvg,
  Sun as SunSvg,
  Target as TargetSvg,
  TimerReset as TimerResetSvg,
  TrendingUp as TrendingUpSvg,
  UserPlus as UserPlusSvg,
  Users as UsersSvg,
  Volume2 as Volume2Svg,
  VolumeX as VolumeXSvg,
  X as XSvg,
  SearchRemoveIcon,
  FilterRemoveIcon,
  CursorPointer01Icon,
  InboxIcon,
  Timer01Icon,
  CheckmarkCircle02Icon,
  GridViewIcon,
  KanbanIcon,
  Upload01Icon,
  UserLock01Icon,
  Calendar03Icon,
  CalendarAdd01Icon,
  Location01Icon,
  Video01Icon,
  RepeatIcon,
  Link01Icon,
  ChampionIcon,
  CrownIcon,
  ArrowUp01Icon,
  ArrowDown01Icon,
} from "@hugeicons/core-free-icons";

type IconProps = Omit<HugeiconsIconProps, "icon">;

function icon(svg: IconSvgElement) {
  return forwardRef<SVGSVGElement, IconProps>(function StudioIcon(
    { strokeWidth = 1.8, ...props },
    ref,
  ) {
    return <HugeiconsIcon ref={ref} icon={svg} strokeWidth={strokeWidth} {...props} />;
  });
}

export type Icon = ReturnType<typeof icon>;

export const AlertTriangle = icon(AlertTriangleSvg);
export const Archive = icon(Archive02Icon);
export const ArrowLeft = icon(ArrowLeftSvg);
export const ArrowRight = icon(ArrowRightSvg);
export const ArrowUpRight = icon(ArrowUpRightSvg);
export const AtSign = icon(AtSignSvg);
export const Bell = icon(BellSvg);
export const BellRing = icon(BellRingSvg);
export const BellOff = icon(BellOffSvg);
export const BookOpenText = icon(BookOpenTextSvg);
export const Bookmark = icon(BookmarkSvg);
export const CalendarDays = icon(CalendarDaysSvg);
export const Check = icon(CheckSvg);
export const CheckCheck = icon(CheckCheckSvg);
export const CheckSquare2 = icon(CheckmarkSquare02Icon);
export const ChevronDown = icon(ChevronDownSvg);
export const ChevronLeft = icon(ChevronLeftSvg);
export const ChevronRight = icon(ChevronRightSvg);
export const CircleAlert = icon(CircleAlertSvg);
export const Clock3 = icon(Clock3Svg);
export const Columns3 = icon(Columns3Svg);
export const Copy = icon(CopySvg);
export const Database = icon(DatabaseSvg);
export const Download = icon(DownloadSvg);
export const Edit = icon(Edit02Icon);
export const Eye = icon(EyeSvg);
export const FilePlus2 = icon(FilePlusIcon);
export const FileQuestion = icon(FileQuestionMarkIcon);
export const FileText = icon(FileTextSvg);
export const Filter = icon(FilterSvg);
export const Focus = icon(FocusSvg);
export const FolderOpen = icon(FolderOpenSvg);
export const Hash = icon(HashSvg);
export const Home = icon(HomeSvg);
export const Info = icon(InfoSvg);
export const KeyRound = icon(KeyRoundSvg);
export const Layers3 = icon(Layers01Icon);
export const LayoutDashboard = icon(LayoutDashboardSvg);
export const ListTodo = icon(ListTodoSvg);
export const LockKeyhole = icon(LockKeyholeSvg);
export const LogOut = icon(LogOutSvg);
export const Mail = icon(MailSvg);
export const MailCheck = icon(MailCheckSvg);
export const Menu = icon(MenuSvg);
export const Moon = icon(MoonSvg);
export const MessageCircle = icon(MessageCircleSvg);
export const MessageSquareText = icon(MessageSquareTextSvg);
export const MoreHorizontal = icon(MoreHorizontalSvg);
export const PanelLeftClose = icon(PanelLeftCloseSvg);
export const PanelLeftOpen = icon(PanelLeftOpenSvg);
export const Paperclip = icon(PaperclipSvg);
export const Pause = icon(PauseSvg);
export const Pin = icon(PinSvg);
export const Play = icon(PlaySvg);
export const Plus = icon(PlusSvg);
export const RefreshCw = icon(RefreshCwSvg);
// A counter-clockwise arrow (the set's own RotateCcw draws a hand gesture, which reads as nothing).
export const RotateCcw = icon(Undo02Icon);
export const Reply = icon(ArrowTurnBackwardIcon);
export const Scale = icon(ScaleSvg);
export const Search = icon(SearchSvg);
export const Send = icon(SendSvg);
export const Settings = icon(SettingsSvg);
export const ShieldCheck = icon(ShieldCheckSvg);
export const SmilePlus = icon(SmilePlusSvg);
export const Sparkles = icon(SparklesSvg);
export const Square = icon(SquareSvg);
export const Sun = icon(SunSvg);
export const Target = icon(TargetSvg);
export const TimerReset = icon(TimerResetSvg);
export const TrendingUp = icon(TrendingUpSvg);
export const UserPlus = icon(UserPlusSvg);
export const Users = icon(UsersSvg);
export const Trophy = icon(ChampionIcon);
export const Crown = icon(CrownIcon);
export const TrendUp = icon(ArrowUp01Icon);
export const TrendDown = icon(ArrowDown01Icon);
export const Volume2 = icon(Volume2Svg);
export const VolumeX = icon(VolumeXSvg);
export const X = icon(XSvg);
export const SearchX = icon(SearchRemoveIcon);
export const FilterX = icon(FilterRemoveIcon);
export const PointerClick = icon(CursorPointer01Icon);
export const Inbox = icon(InboxIcon);
export const Timer = icon(Timer01Icon);
export const CircleCheck = icon(CheckmarkCircle02Icon);
export const LayoutGrid = icon(GridViewIcon);
export const Kanban = icon(KanbanIcon);
export const Upload = icon(Upload01Icon);
export const UserLock = icon(UserLock01Icon);
export const Calendar = icon(Calendar03Icon);
export const CalendarPlus = icon(CalendarAdd01Icon);
export const MapPin = icon(Location01Icon);
export const Video = icon(Video01Icon);
export const Repeat = icon(RepeatIcon);
export const LinkIcon = icon(Link01Icon);
