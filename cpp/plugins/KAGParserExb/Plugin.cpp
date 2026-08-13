// KAGParserExb.dll link callback, aligned with libkrkr2.so 0x55A618.
#define NCB_MODULE_NAME TJS_W("KAGParserExb.dll")
#include "ncbind.hpp"
#include "KAGParserEx.hpp"

namespace {
void RegisterKAGParserExb() {
    kagparserexb::tTJSNI_KAGParser::initMethod();

    iTJSDispatch2 *global = TVPGetScriptDispatch();
    if(!global)
        return;

    iTJSDispatch2 *parserClass =
        kagparserexb::tTJSNC_KAGParser::CreateNativeClass();
    tTJSVariant value(parserClass);
    parserClass->Release();
    global->PropSet(TJS_MEMBERENSURE, TVP_KAGPARSER_EX_CLASSNAME, nullptr,
                    &value, global);
    global->Release();
}
} // namespace

NCB_PRE_REGIST_CALLBACK(RegisterKAGParserExb);
