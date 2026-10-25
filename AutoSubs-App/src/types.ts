import { SupportedUiLanguage } from '@/i18n';
import { Integration } from '@/contexts/IntegrationContext';

// Error message interface
export interface ErrorMsg {
    title: string;
    desc: string;
}

export interface Track {
    value: string;
    label: string;
}

export interface TimelineInfo {
    name: string;
    timelineId: string;
    inputTracks: Track[];
    outputTracks: Track[];
    projectName: string;
    /** Tells apart projects that share a name: the Premiere .prproj path. */
    projectId?: string;
}

// Subtitle Interfaces
export interface Word {
    word: string;
    start: number;
    end: number;
    line_number: number;
    probability?: number;
}
export interface Subtitle {
    id: number;
    start: number;
    end: number;
    text: string;
    words: Array<Word>;
    speaker_id?: string;
}

/**
 * Which pipeline stage last touched a segment. Mirrors the Rust `SegmentStage`.
 * The same segment index can be emitted twice per run, so this distinguishes
 * new text from refined word timings.
 */
export type SegmentStage = 'transcribe' | 'translate' | 'align';

/**
 * A segment in the live preview, before formatting has run. Unlike `Subtitle`
 * these are not display-ready: they carry no id, may be far longer than the
 * user's configured line length, and may still be untranslated.
 */
export type DraftSubtitle = Omit<Subtitle, 'id'> & {
    id?: number;
    stage?: SegmentStage;
};

export interface Sample {
    start: number;
    end: number;
}
export interface Speaker {
    name: string;
    style: "Fill" | "Outline" | "None";
    color: string; // hex
    sample: Sample;
    track?: string;
}

// Model Interface
export interface Model {
    value: string
    label: string
    description: string
    size: string
    /** Peak memory at load. A hard constraint: below this, the model won't run. */
    ramMb: number
    image: string
    details: string
    badge: string
    engine: string
    languageSupport:
    | { kind: "multilingual" }
    | { kind: "single_language"; language: string }
    | { kind: "restricted"; languages: string[] }
    accuracy: number // 1-5 in steps of 0.5, 5 = best in class
    speed: number // 1-5 in steps of 0.5, 5 = fastest
    /**
     * Languages this model is a proven strong choice for, which promote it
     * within its accuracy tier. Resolved from the manifest — absent there means
     * "every language it supports"; empty here means "fallback only".
     */
    bestFor: string[]
    isDownloaded: boolean
    repositoryUrl?: string
    license?: {
        spdx: string
        url: string
        attribution: string
        commercialUse: boolean
    }
}

// Settings Interface
export interface Settings {
    // Mode
    audioInputMode: "file" | "timeline",

    // UI settings
    uiLanguage: SupportedUiLanguage;
    onboardingCompleted: boolean;
    lastSeenVersion: string;
    showEnglishOnlyModels: boolean;

    // Survey notification settings
    timesDismissedSurvey: number;
    lastSurveyDate: string;

    // Milestone tracking
    transcriptionsCompleted: number;
    subSlateMilestoneShown: boolean;

    // Processing settings
    model: number; // index of model in models array
    language: string,
    translate: boolean,
    targetLanguage: string,
    enableDiarize: boolean,
    maxSpeakers: number | null,
    enableDTW: boolean,
    enableForcedAlignment: boolean,
    enableGpu: boolean,

    // Text settings
    textDensity: "less" | "standard" | "more" | "single" | "custom",
    maxLinesPerSubtitle: number,
    splitOnPunctuation: boolean,
    textCase: "none" | "uppercase" | "lowercase" | "titlecase";
    removePunctuation: boolean,
    enableCensor: boolean,
    censoredWords: Array<string>,
    activeCensorLists: Array<string>,  // IDs of CensorWordLists toggled on
    exportRange?: "entire" | "inout",
    customPrompt: string,
    customMaxCharsPerLine: number,

    // Stock footage search (AI Edit search_media), read by the backend
    pexelsApiKey: string;
    pixabayApiKey: string;

    // Audio tracks to transcribe, per editor
    selectedInputTracksByApp: Record<Integration, string[]>;

    // Animation settings
    animationType: string;
    highlightType: string;
    highlightColor: string;
}

// A named list of censored words that can be toggled on/off as a group.
// Built-in lists are shipped with the app; user lists are persisted to settings.
export interface CensorWordList {
    id: string;            // "builtin:<slug>" for shipped lists, uuid for user-created
    name: string;
    description?: string;
    builtIn: boolean;
    words: string[];
}

export interface TranscriptionOptions {
    audioPath: string,
    offset: number,
    model: string,
    lang: string,
    translate: boolean,
    targetLanguage: string,
    enableDtw: boolean,
    enableForcedAlignment: boolean,
    enableGpu: boolean,
    enableDiarize: boolean,
    maxSpeakers: number | null,
    density: "less" | "standard" | "more" | "single" | "custom",
    maxLines: number,
    customMaxCharsPerLine?: number | undefined,
    // Content formatting applied in the Rust backend.
    textCase: "none" | "uppercase" | "lowercase" | "titlecase",
    removePunctuation: boolean,
    censoredWords: string[],
    customPrompt?: string,
    // Pre-resolved model paths from ensure_models.
    asrModelPath?: string,
    vadModelPath?: string,
    diarizeSegmentPath?: string,
    diarizeEmbeddingPath?: string,
    alignerModelDir?: string,
}

export interface EnsureModelsRequest {
    model: string,
    enable_vad: boolean,
    enable_diarize: boolean,
    enable_forced_alignment: boolean,
}

export interface EnsureModelsResponse {
    asr_model_path: string,
    vad_model_path?: string,
    diarize_segment_path?: string,
    diarize_embedding_path?: string,
    aligner_dir?: string,
}

// Formatting options for reformatting subtitles without re-transcribing
export interface FormattingOptions {
    maxLines?: number,
    textDensity?: "less" | "standard" | "more" | "single" | "custom",
    customMaxCharsPerLine?: number,
    language?: string,
    // Content formatting (applied by Rust backend after structural line wrapping).
    textCase?: "none" | "uppercase" | "lowercase" | "titlecase",
    removePunctuation?: boolean,
    censoredWords?: string[],
}

// Segment format expected by the backend reformat command
export interface BackendSegment {
    start: number,
    end: number,
    text: string,
    speaker_id?: string,
    words?: Array<{
        word: string,
        start: number,
        end: number,
        probability?: number,
    }>,
}
