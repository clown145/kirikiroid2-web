// KAGParserEx.dll link callback, aligned with libkrkr2.so 0x5588B4.
#define NCB_MODULE_NAME TJS_W("KAGParserEx.dll")
#include "ncbind.hpp"
#include "KAGParserEx.hpp"

namespace {
iTJSDispatch2 *OriginalKAGParser = nullptr;

void RegisterKAGParserEx() {
    kagparserex::tTJSNI_KAGParser::initMethod();

    iTJSDispatch2 *global = TVPGetScriptDispatch();
    if(!global)
        return;

    tTJSVariant value;
    if(TJS_SUCCEEDED(global->PropGet(0, TVP_KAGPARSER_EX_CLASSNAME, nullptr,
                                     &value, global))) {
        OriginalKAGParser = value.AsObject();
        value.Clear();
    }

    iTJSDispatch2 *parserClass =
        kagparserex::tTJSNC_KAGParser::CreateNativeClass();
    value = tTJSVariant(parserClass);
    parserClass->Release();
    global->PropSet(TJS_MEMBERENSURE, TVP_KAGPARSER_EX_CLASSNAME, nullptr,
                    &value, global);
    global->Release();
}
} // namespace

NCB_PRE_REGIST_CALLBACK(RegisterKAGParserEx);
