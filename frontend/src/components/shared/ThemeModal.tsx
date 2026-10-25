
import { useTranslations } from "@/i18n/compat/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ThemedAlertDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
}

const ThemeModal = ({
  isOpen,
  onClose,
  onConfirm,
  title,
}: ThemedAlertDialogProps) => {
  const t = useTranslations("themeModal.delete");
  const description = String(t.raw("description"));

  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>
            <span>
              {description.split("{title}")[0]}
              <span className="px-1 font-semibold text-foreground">{title}</span>
              {description.split("{title}")[1]}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t("cancelText")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.stopPropagation();
              onConfirm();
            }}
            className="bg-danger hover:opacity-90 text-white focus:ring-danger border-none"
          >
            {t("confirmText")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default ThemeModal;
