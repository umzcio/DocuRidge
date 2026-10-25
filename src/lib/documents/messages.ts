/**
 * Fixed texts for a document that cannot be shown. Shared by the routes that
 * serve documents and by the viewers in the browser, so this module imports
 * nothing.
 */

/** Every "cannot be shown" answer (409, and the body of a 503); no exception text is ever echoed. */
export const CANONICAL_UNAVAILABLE_MESSAGE = "This document can't be shown right now. Contact the sender.";

/** A viewer that gave up waiting out 503s, and a submit refused while the worker is busy. */
export const CANONICAL_BUSY_MESSAGE = 'DocuRidge is busy preparing this document. Try again shortly.';

/** Any other failure to load a document in a viewer. */
export const DOCUMENT_LOAD_FAILED_MESSAGE = "This document couldn't be loaded. Reload the page to try again.";
