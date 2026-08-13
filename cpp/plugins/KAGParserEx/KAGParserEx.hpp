#ifndef KRKR2_KAGPARSEREX_HPP
#define KRKR2_KAGPARSEREX_HPP

#include "tp_stub.h"
#include "EventIntf.h"
#include "tjsGlobalStringMap.h"
#include "../../core/tjs2/tjsHashSearch.h"

#include <cstring>
#include <vector>

using namespace TJS;

#define TVP_KAGPARSER_EX_PLUGIN
#define TVP_KAGPARSER_EX_CLASSNAME TJS_W("KAGParser")
#define TVP_KAGPARSER_MESSAGEMAP(name)                                       \
    (TJSGetMessageMapMessage(TJS_W(#name)).c_str())

#ifdef TVPThrowInternalError
#undef TVPThrowInternalError
#endif
#define TVPThrowInternalError                                                \
    TVPThrowExceptionMessage(TVP_KAGPARSER_MESSAGEMAP(TVPInternalError),     \
                             __FILE__, __LINE__)

#include "KAGParser.h"

#endif
