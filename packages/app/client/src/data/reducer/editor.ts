//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.
//
// Microsoft Bot Framework: http://botframework.com
//
// Bot Framework Emulator Github:
// https://github.com/Microsoft/BotFramwork-Emulator
//
// Copyright (c) Microsoft Corporation
// All rights reserved.
//
// MIT License:
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED ""AS IS"", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//

import { deepCopySlow } from '@bfemulator/app-shared';
import * as Constants from '../../constants';
import * as EditorActions from '../action/editorActions';
import { EditorAction } from '../action/editorActions';
import { getOtherTabGroup, tabGroupHasDocuments } from '../editorHelpers';

export interface IEditorState {
  // TODO: enum editors
  activeEditor?: string;
  draggingTab?: boolean;
  editors?: { [editorKey: string]: IEditor };
}

// TODO: rename all mentions of editor to tab group
/** Represents an editor (tab group) */
export interface IEditor {
  activeDocumentId?: string;
  documents?: { [documentId: string]: IDocument };
  /** UI representation of tab order in tab bar */
  tabOrder?: string[];
  /** Updated list of recently-used tabs (used to be tabStack) */
  recentTabs?: string[];
}

export interface IDocument {
  // TODO: enum content types
  contentType?: string;
  dirty?: boolean;
  documentId?: string;
  fileName?: string;
  isGlobal?: boolean;
  meta?: any;
}

const DEFAULT_STATE: IEditorState = {
  activeEditor: Constants.EditorKey_Primary,
  draggingTab: false,
  editors: {
    [Constants.EditorKey_Primary]: getNewEditor(),
    [Constants.EditorKey_Secondary]: getNewEditor()
  }
};

export default function editor(state: IEditorState = DEFAULT_STATE, action: EditorAction): IEditorState {
  Object.freeze(state);

  switch (action.type) {
    case EditorActions.APPEND_TAB: {
      const { srcEditorKey } = action.payload;
      const { destEditorKey } = action.payload;

      /** if the tab is being appended to the end of its own editor, just re-adjust tab order */
      if (srcEditorKey === destEditorKey) {
        let tabOrder = [...state.editors[srcEditorKey].tabOrder];
        tabOrder = [...tabOrder.filter(docId => docId !== action.payload.documentId), action.payload.documentId];

        let editorState: IEditor = {
          ...state.editors[srcEditorKey],
          tabOrder: tabOrder
        };
        state = setEditorState(srcEditorKey, editorState, state);
        break;
      }

      /** if the tab is being appended to another editor, we need to modify both editors' docs, recent tabs, and tab order */

      const docToAppend = state.editors[srcEditorKey].documents[action.payload.documentId];

      // remove any trace of document from source editor
      const srcEditor = removeDocumentFromTabGroup(state.editors[srcEditorKey], action.payload.documentId);

      // add the tab to the dest editor
      const destTabOrder = [...state.editors[destEditorKey].tabOrder, action.payload.documentId];
      const destRecentTabs = [...state.editors[destEditorKey].recentTabs, action.payload.documentId];
      const destDocs = Object.assign({}, state.editors[destEditorKey].documents);
      destDocs[action.payload.documentId] = docToAppend;

      const destEditor: IEditor = {
        ...state.editors[destEditorKey],
        documents: destDocs,
        recentTabs: destRecentTabs,
        tabOrder: destTabOrder
      };

      if (!tabGroupHasDocuments(srcEditor) && srcEditorKey === Constants.EditorKey_Primary) {
        state = setNewPrimaryEditor(destEditor, state);
      } else {
        state = setActiveEditor(!tabGroupHasDocuments(srcEditor) ? destEditorKey : state.activeEditor, state);
        state = setEditorState(srcEditorKey, srcEditor, state);
        state = setEditorState(destEditorKey, destEditor, state);
      }
      state = setDraggingTab(false, state);
      break;
    }

    case EditorActions.CLOSE: {
      // TODO: Add logic to check if document has been saved
      // & prompt user to save document if necessary

      const { editorKey } = action.payload;

      // remove any trace of document from editor
      const editor = removeDocumentFromTabGroup(state.editors[editorKey], action.payload.documentId);

      // close empty editor if there is another one able to take its place
      const newPrimaryEditorKey = getOtherTabGroup(editorKey);
      if (!tabGroupHasDocuments(editor) && state.editors[newPrimaryEditorKey]) {
        // if the editor being closed is the primary editor, have the secondary editor become the primary
        const tmp: IEditor = Object.assign({}, state.editors[newPrimaryEditorKey]);
        state = setNewPrimaryEditor(tmp, state);
      } else {
        state = setEditorState(editorKey, editor, state);
      }
      break;
    }

    case EditorActions.CLOSE_ALL: {
      if (action.payload.includeGlobal) {
        return DEFAULT_STATE;
      } else {
        let newState: IEditorState = {
          ...state
        };

        for (let key in state.editors) {
          let tabGroup = state.editors[key];
          if (tabGroup) {
            let newTabOrder = [...tabGroup.tabOrder];
            let newRecentTabs = [...tabGroup.recentTabs];
            const newDocs = {};

            Object.keys(tabGroup.documents).forEach(documentId => {
              const document = tabGroup.documents[documentId];
              if (document.isGlobal) {
                newDocs[documentId] = document;
              } else {
                newTabOrder = newTabOrder.filter(documentId => documentId != document.documentId);
                newRecentTabs = newRecentTabs.filter(documentId => documentId != document.documentId);
              }
            });

            let newTabGroup: IEditor = {
              activeDocumentId: newRecentTabs[0] || null,
              documents: newDocs,
              recentTabs: newRecentTabs,
              tabOrder: newTabOrder
            };

            newState = {
              ...newState,
              editors: {
                ...newState.editors,
                [key]: newTabGroup
              }
            };
          }
        }
        state = fixupTabGroups(newState);
      }
      break;
    }

    case EditorActions.OPEN: {
      const editorKey = state.activeEditor;
      const otherTabGroup = getOtherTabGroup(editorKey);

      // if the document is already in another tab group, focus that one
      if (tabGroupHasDocuments(state.editors[otherTabGroup]) && state.editors[otherTabGroup].documents[action.payload.documentId]) {
        const recentTabs = [...state.editors[otherTabGroup].recentTabs].filter(docId => docId !== action.payload.documentId);
        recentTabs.unshift(action.payload.documentId);
        const tabGroupState: IEditor = {
          ...state.editors[otherTabGroup],
          activeDocumentId: action.payload.documentId,
          recentTabs
        };
        state = setEditorState(otherTabGroup, tabGroupState, state);
        state = setActiveEditor(otherTabGroup, state);
        break;
      }
      //if the document is new, insert it into the tab order after the current active document
      let newTabOrder;
      if (state.editors[editorKey].documents[action.payload.documentId]) {
        newTabOrder = [...state.editors[editorKey].tabOrder];
      } else {
        const activeDocumentId = state.editors[state.activeEditor].activeDocumentId;
        const activeIndex = state.editors[editorKey].tabOrder.indexOf(activeDocumentId);
        if (activeIndex != null && activeIndex != -1) {
          state.editors[editorKey].tabOrder.splice(activeIndex + 1, 0, action.payload.documentId);
          newTabOrder = [...state.editors[editorKey].tabOrder];
        } else {
          newTabOrder = [...state.editors[editorKey].tabOrder, action.payload.documentId];
        }
      }

      // move document to top of recent tabs
      const newRecentTabs = [...state.editors[editorKey].recentTabs].filter(docId => docId !== action.payload.documentId);
      newRecentTabs.unshift(action.payload.documentId);

      // add document to tab group
      const newDocs = Object.assign({}, state.editors[editorKey].documents);
      newDocs[action.payload.documentId] = action.payload;

      const editorState: IEditor = {
        ...state.editors[editorKey],
        activeDocumentId: action.payload.documentId,
        documents: newDocs,
        recentTabs: newRecentTabs,
        tabOrder: newTabOrder
      };
      state = setEditorState(editorKey, editorState, state);
      state = setActiveEditor(editorKey, state);
      break;
    }

    case EditorActions.UPDATE_DOCUMENT: {
      const { payload: updatedDocument }: { payload: IDocument } = action;

      const { editors } = state;
      const editorKeys = Object.keys(editors);
      let i = editorKeys.length;
      outer:while (i--) {
        const documents = editors[editorKeys[i]].documents;
        const documentKeys = Object.keys(documents);
        let j = documentKeys.length;
        while (j--) {
          const document = documents[documentKeys[j]];
          if (document.documentId === updatedDocument.documentId) {
            documents[documentKeys[j]] = { ...document, ...updatedDocument };
            break outer;
          }
        }
      }
      state = { ...state };
      break;
    }

    case EditorActions.SET_ACTIVE_EDITOR: {
      state = setActiveEditor(action.payload.editorKey, state);
      break;
    }

    case EditorActions.SET_ACTIVE_TAB: {
      Constants.EditorKeys.forEach(editorKey => {
        if (state.editors[editorKey] && state.editors[editorKey].documents[action.payload.documentId]) {
          const recentTabs = state.editors[editorKey].recentTabs.filter(tabId => tabId !== action.payload.documentId);
          recentTabs.unshift(action.payload.documentId);

          const editorState = {
            ...state.editors[editorKey],
            activeDocumentId: action.payload.documentId,
            recentTabs
          };
          state = setEditorState(editorKey, editorState, state);
          state = setActiveEditor(editorKey, state);
        }
      });
      break;
    }

    case EditorActions.SET_DIRTY_FLAG: {
      Constants.EditorKeys.forEach(editorKey => {
        if (state.editors[editorKey] && state.editors[editorKey].documents[action.payload.documentId]) {
          const newDocs = Object.assign({}, state.editors[editorKey].documents);
          const docToSet = newDocs[action.payload.documentId];
          docToSet.dirty = action.payload.dirty;

          const editorState: IEditor = {
            ...state.editors[editorKey],
            documents: newDocs
          };
          state = setEditorState(editorKey, editorState, state);
        }
      });
      break;
    }

    case EditorActions.SPLIT_TAB: {
      const { srcEditorKey } = action.payload;
      const { destEditorKey } = action.payload;

      const docToAppend = state.editors[srcEditorKey].documents[action.payload.documentId];

      // remove any trace of document from source editor
      const srcEditor = removeDocumentFromTabGroup(state.editors[srcEditorKey], action.payload.documentId);

      // add the document to the dest editor
      const destEditor: IEditor = state.editors[destEditorKey] ? Object.assign({}, state.editors[destEditorKey]) : getNewEditor();
      const destTabOrder = [...destEditor.tabOrder, action.payload.documentId];
      const destRecentTabs = [...destEditor.recentTabs];
      destRecentTabs.unshift(action.payload.documentId);
      const destDocs = Object.assign({}, destEditor.documents);
      destDocs[action.payload.documentId] = docToAppend;

      destEditor.activeDocumentId = action.payload.documentId;
      destEditor.documents = destDocs;
      destEditor.recentTabs = destRecentTabs;
      destEditor.tabOrder = destTabOrder;

      state = setActiveEditor(destEditorKey, state);
      state = setEditorState(srcEditorKey, srcEditor, state);
      state = setEditorState(destEditorKey, destEditor, state);
      state = setDraggingTab(false, state);
      break;
    }

    case EditorActions.SWAP_TABS: {
      const { srcEditorKey } = action.payload;
      const { destEditorKey } = action.payload;

      /** swapping tabs within the same tab group */
      if (srcEditorKey == destEditorKey) {
        // only change tab order
        const tabOrder = [...state.editors[srcEditorKey].tabOrder];
        const srcTabIndex = tabOrder.findIndex(docId => docId === action.payload.srcTabId);
        const destTabIndex = tabOrder.findIndex(docId => docId === action.payload.destTabId);

        const destTab = tabOrder[destTabIndex];
        tabOrder[destTabIndex] = tabOrder[srcTabIndex];
        tabOrder[srcTabIndex] = destTab;

        let editorState = {
          ...state.editors[srcEditorKey],
          tabOrder
        };

        state = setEditorState(srcEditorKey, editorState, state);
        break;
      }

      /** swapping tab into a different tab group */
      const docToSwap = state.editors[srcEditorKey].documents[action.payload.srcTabId];

      // remove any trace of document from source editor
      const srcEditor = removeDocumentFromTabGroup(state.editors[srcEditorKey], action.payload.srcTabId);

      // add the document to the destination tab group
      const destEditor: IEditor = Object.assign({}, state.editors[destEditorKey]);
      destEditor.documents[action.payload.srcTabId] = docToSwap;
      const destRecentTabs = [...destEditor.recentTabs, action.payload.srcTabId];
      destEditor.recentTabs = destRecentTabs;
      // insert before the destination tab's position
      const destTabIndex = destEditor.tabOrder.findIndex(docId => docId === action.payload.destTabId);
      const destTabOrder = [...destEditor.tabOrder.splice(0, destTabIndex), action.payload.srcTabId, ...destEditor.tabOrder];
      destEditor.tabOrder = destTabOrder;

      if (!tabGroupHasDocuments(srcEditor) && srcEditorKey === Constants.EditorKey_Primary) {
        state = setNewPrimaryEditor(destEditor, state);
      } else {
        state = setActiveEditor(!tabGroupHasDocuments(srcEditor) ? destEditorKey : state.activeEditor, state);
        state = setEditorState(srcEditorKey, srcEditor, state);
        state = setEditorState(destEditorKey, destEditor, state);
      }
      break;
    }

    case EditorActions.TOGGLE_DRAGGING_TAB: {
      state = setDraggingTab(action.payload.draggingTab, state);
      break;
    }

    default:
      break;
  }

  return state;
}

function getNewEditor(): IEditor {
  return {
    activeDocumentId: null,
    documents: {},
    recentTabs: [],
    tabOrder: []
  };
}

/** Removes all trace of a document from a tab group and returns
 *  the updated state, or a new editor if the tab group has no documents (empty)
 */
function removeDocumentFromTabGroup(tabGroup: IEditor, documentId: string): IEditor {
  const newTabOrder = [...tabGroup.tabOrder].filter(docId => docId !== documentId);
  const newRecentTabs = [...tabGroup.recentTabs].filter(docId => docId !== documentId);
  const newDocs = Object.assign({}, tabGroup.documents);
  delete newDocs[documentId];
  const newActiveDocumentId = newRecentTabs[0] || null;

  const newTabGroup: IEditor = Object.keys(newDocs).length === 0 ? getNewEditor() : {
    ...tabGroup,
    activeDocumentId: newActiveDocumentId,
    documents: newDocs,
    recentTabs: newRecentTabs,
    tabOrder: newTabOrder
  };
  return newTabGroup;
}

function setEditorState(editorKey: string, editorState: IEditor, state: IEditorState): IEditorState {
  let newState = deepCopySlow(state);

  newState.editors[editorKey] = editorState;
  return newState;
}

function setActiveEditor(editorKey: string, state: IEditorState): IEditorState {
  let newState = deepCopySlow(state);

  newState.activeEditor = editorKey;
  return newState;
}

/** Sets a new primary editor, and destroys the secondary editor */
function setNewPrimaryEditor(newPrimaryEditor: IEditor, state: IEditorState): IEditorState {
  let newState = deepCopySlow(state);

  newState.editors[Constants.EditorKey_Secondary] = getNewEditor();
  newState.editors[Constants.EditorKey_Primary] = newPrimaryEditor;
  newState.activeEditor = Constants.EditorKey_Primary;
  return newState;
}

function setDraggingTab(dragging: boolean, state: IEditorState): IEditorState {
  let newState = deepCopySlow(state);

  newState.draggingTab = dragging;
  return newState;
}

/** Sets the secondary tab group as the primary if the primary is now empty */
function fixupTabGroups(state: IEditorState): IEditorState {
  if (!tabGroupHasDocuments(state.editors[Constants.EditorKey_Primary])
    && tabGroupHasDocuments(state.editors[Constants.EditorKey_Secondary])) {
    state = setNewPrimaryEditor(state.editors[Constants.EditorKey_Secondary], state);
  }

  if (state.activeEditor === Constants.EditorKey_Secondary && !tabGroupHasDocuments(state.editors[Constants.EditorKey_Secondary])) {
    state = setActiveEditor(Constants.EditorKey_Primary, state);
  }

  return state;
}
