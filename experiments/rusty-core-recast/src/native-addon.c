#include <dlfcn.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

typedef void *napi_env;
typedef void *napi_value;
typedef void *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef int (*napi_create_function_fn)(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
typedef int (*napi_set_named_property_fn)(napi_env, napi_value, const char *, napi_value);
typedef int (*napi_get_cb_info_fn)(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
typedef int (*napi_get_value_string_utf8_fn)(napi_env, napi_value, char *, size_t, size_t *);
typedef int (*napi_create_string_utf8_fn)(napi_env, const char *, size_t, napi_value *);

#define NAPI_OK 0
#define NAPI_AUTO_LENGTH ((size_t)-1)

extern char *rusty_core_recast_scan_plan_json(const char *path);
extern void rusty_core_recast_free_string(char *value);

static void *node_symbol(const char *name) {
    return dlsym(RTLD_DEFAULT, name);
}

static napi_value scan_resident_transcript(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf8_fn napi_get_value_string_utf8 = (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    napi_create_string_utf8_fn napi_create_string_utf8 = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    if (!napi_get_cb_info || !napi_get_value_string_utf8 || !napi_create_string_utf8) return NULL;

    size_t argc = 1;
    napi_value args[1] = {0};
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != NAPI_OK || argc != 1 || !args[0]) return NULL;

    size_t path_length = 0;
    if (napi_get_value_string_utf8(env, args[0], NULL, 0, &path_length) != NAPI_OK) return NULL;
    char *path = malloc(path_length + 1);
    if (!path) return NULL;
    if (napi_get_value_string_utf8(env, args[0], path, path_length + 1, &path_length) != NAPI_OK) {
        free(path);
        return NULL;
    }

    char *json = rusty_core_recast_scan_plan_json(path);
    free(path);
    if (!json) return NULL;

    napi_value result = NULL;
    napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &result);
    rusty_core_recast_free_string(json);
    return result;
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    napi_create_function_fn napi_create_function = (napi_create_function_fn)node_symbol("napi_create_function");
    napi_set_named_property_fn napi_set_named_property = (napi_set_named_property_fn)node_symbol("napi_set_named_property");
    if (!napi_create_function || !napi_set_named_property) return exports;

    napi_value function = NULL;
    if (napi_create_function(env, "scanResidentTranscript", NAPI_AUTO_LENGTH, scan_resident_transcript, NULL, &function) == NAPI_OK) {
        napi_set_named_property(env, exports, "scanResidentTranscript", function);
    }
    return exports;
}

void *rusty_core_recast_napi_register_module(void) {
    return (void *)napi_register_module_v1;
}
