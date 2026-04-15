#!/usr/bin/env python3
"""
fix_encoding.py
Fixes Windows-1252 corruption in UTF-8 files.
Run from project root: python fix_encoding.py
"""
import os
import glob

# These are the byte sequences that result from UTF-8 being misread as Windows-1252
FIXES = [
    # Swedish chars
    ('\u00c3\u00a5', 'a'),   # å
    ('\u00c3\u00a4', 'a'),   # ä  
    ('\u00c3\u00b6', 'o'),   # ö
    ('\u00c3\u2026', 'A'),   # Å
    ('\u00c3\u201e', 'A'),   # Ä
    ('\u00c3\u2013', 'O'),   # Ö
    # Punctuation
    ('\u00e2\u20ac\u201c', '-'),   # em dash
    ('\u00e2\u20ac\u2122', "'"),   # right single quote
    ('\u00e2\u20ac\u0153', '"'),   # left double quote
    ('\u00e2\u20ac', '"'),         # double quote variant
    ('\u00c2\u00b7', '.'),         # middle dot
    ('\u00c2\u00a9', '(c)'),       # copyright
    # Cleanup leftover bytes
    ('\u00c3', ''),
    ('\u00c2', ''),
]

files = glob.glob('app/**/*.tsx', recursive=True) + glob.glob('app/**/*.ts', recursive=True)
fixed = 0

for filepath in files:
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        
        original = content
        for bad, good in FIXES:
            content = content.replace(bad, good)
        
        if content != original:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f'Fixed: {filepath}')
            fixed += 1
    except Exception as e:
        print(f'Error: {filepath}: {e}')

print(f'\nFixed {fixed} files')
print('\nNow run:')
print('  git add .')
print('  git commit -m "Fix encoding corruption"')
print('  vercel --prod')
