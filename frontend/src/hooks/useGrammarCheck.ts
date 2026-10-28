import { useGrammarStore } from "@/store/useGrammarStore";

export interface GrammarError {
  text: string;
  message: string;
  type: "spelling" | "grammar";
  suggestions: string[];
}

export const useGrammarCheck = () => {
  const {
    errors,
    isChecking,
    hasChecked,
    selectedErrorIndex,
    checkGrammar,
    clearErrors,
    selectError,
    dismissError,
    remarkErrors,
  } = useGrammarStore();

  return {
    errors,
    isChecking,
    hasChecked,
    selectedErrorIndex,
    checkGrammar,
    clearErrors,
    selectError,
    dismissError,
    remarkErrors,
  };
};
