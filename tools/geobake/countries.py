"""Per-country bake settings. Add an entry here to bake another country."""
COUNTRIES = {
    "nl": {
        "name": "Netherlands",
        "iso": "NL",
        # W, S, E, N in degrees (European Netherlands incl. Wadden islands)
        "bbox": (3.2, 50.72, 7.25, 53.58),
        "min_city_pop": 10000,
    },
}
