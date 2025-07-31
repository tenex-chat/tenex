#!/bin/bash

echo "Finding orphaned TypeScript/JavaScript files in src/"
echo "===================================================="
echo

# Function to check if a file is imported
check_file_imports() {
    local file=$1
    local filename=$(basename "$file")
    local dirname=$(dirname "$file")
    local basename_no_ext=${filename%.*}
    
    # For index.ts files, check if the directory is imported
    if [[ "$filename" == "index.ts" ]] || [[ "$filename" == "index.js" ]]; then
        # Get the parent directory name
        local parent_dir=$(basename "$dirname")
        # Check if the directory itself is imported
        local dir_imports=$(rg -c "from ['\"](\.\./|@/|src/).*$parent_dir['\"]" src/ 2>/dev/null | wc -l)
        if [ $dir_imports -gt 0 ]; then
            return 1  # Directory is imported, so index.ts is used
        fi
    fi
    
    # Skip checking for imports in the file itself
    local exclude_pattern="^$file:"
    
    # Various import patterns to check
    local patterns=(
        # Relative imports from parent directories
        "\.\./[^'\"]*$basename_no_ext['\"]"
        "\.\./[^'\"]*$basename_no_ext\.js['\"]"
        # Relative imports from same directory
        "\./$basename_no_ext['\"]"
        "\./$basename_no_ext\.js['\"]"
        # Absolute imports using @/
        "@/${file#src/}"
        "@/[^'\"]*$basename_no_ext['\"]"
        # Module path imports
        "${file#src/}"
        "${file#src/}\.js"
    )
    
    local total_imports=0
    
    for pattern in "${patterns[@]}"; do
        local count=$(rg -c "$pattern" src/ 2>/dev/null | grep -v "$exclude_pattern" | wc -l)
        total_imports=$((total_imports + count))
    done
    
    # Also check for barrel exports (index.ts files that might export this file)
    if [ -f "$dirname/index.ts" ] && [[ "$file" != "$dirname/index.ts" ]]; then
        local index_exports=$(rg -c "from ['\"]\./$basename_no_ext" "$dirname/index.ts" 2>/dev/null || echo 0)
        total_imports=$((total_imports + index_exports))
    fi
    
    return $total_imports
}

# Get all source files (excluding tests)
files=$(find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \) | grep -v "__tests__" | grep -v "\.test\." | grep -v "\.spec\." | sort)

orphaned_files=()

for file in $files; do
    # Skip entry points and common config files
    if [[ "$file" == "src/tenex.ts" ]] || 
       [[ "$file" == "src/index.ts" ]] ||
       [[ "$file" == "src/types.ts" ]] ||
       [[ "$file" == *"/types.ts" ]] ||
       [[ "$file" == *"/constants.ts" ]] ||
       [[ "$file" == *"vite.config.ts" ]] ||
       [[ "$file" == *"jest.config.ts" ]]; then
        continue
    fi
    
    # Skip declaration files
    if [[ "$file" == *".d.ts" ]]; then
        continue
    fi
    
    check_file_imports "$file"
    import_count=$?
    
    if [ $import_count -eq 0 ]; then
        orphaned_files+=("$file")
    fi
done

# Display results
if [ ${#orphaned_files[@]} -eq 0 ]; then
    echo "No orphaned files found!"
else
    echo "Found ${#orphaned_files[@]} potentially orphaned files:"
    echo
    
    # Group files by type
    index_files=()
    regular_files=()
    
    for file in "${orphaned_files[@]}"; do
        if [[ "$(basename "$file")" == "index.ts" ]] || [[ "$(basename "$file")" == "index.js" ]]; then
            index_files+=("$file")
        else
            regular_files+=("$file")
        fi
    done
    
    # Display regular files first
    if [ ${#regular_files[@]} -gt 0 ]; then
        echo "Regular files:"
        echo "--------------"
        for file in "${regular_files[@]}"; do
            echo "📄 $file"
            
            # Show file info
            echo "   Size: $(wc -c < "$file" | xargs) bytes"
            echo "   Lines: $(wc -l < "$file" | xargs)"
            
            # Show exports
            exports=$(rg "^export" "$file" 2>/dev/null | head -3)
            if [ -n "$exports" ]; then
                echo "   Exports:"
                echo "$exports" | sed 's/^/     - /'
            fi
            
            # Show any TODO or DEPRECATED comments
            todos=$(rg "(TODO|DEPRECATED|FIXME)" "$file" 2>/dev/null | head -2)
            if [ -n "$todos" ]; then
                echo "   Notes:"
                echo "$todos" | sed 's/^/     - /'
            fi
            
            echo
        done
    fi
    
    # Display index files separately
    if [ ${#index_files[@]} -gt 0 ]; then
        echo "Index files (potentially unused module entry points):"
        echo "----------------------------------------------------"
        for file in "${index_files[@]}"; do
            echo "📁 $file"
            echo "   Directory: $(dirname "$file")"
            echo "   Exports: $(rg -c "^export" "$file" 2>/dev/null || echo 0) items"
            echo
        done
    fi
fi

# Additional check for files that might be CLI tools or scripts
echo
echo "Additional analysis:"
echo "-------------------"
if [ ${#orphaned_files[@]} -gt 0 ]; then
    standalone_scripts=()
    
    for file in "${orphaned_files[@]}"; do
        # Check if file has a shebang or main execution block
        if head -1 "$file" | grep -q "^#!" || rg -q "if \(__name__ ==|if \(import\.meta\.main\)" "$file"; then
            standalone_scripts+=("$file")
        fi
    done
    
    if [ ${#standalone_scripts[@]} -gt 0 ]; then
        echo "Potential standalone scripts:"
        for file in "${standalone_scripts[@]}"; do
            echo "🔧 $file"
        done
    else
        echo "No standalone scripts detected."
    fi
else
    echo "No files to analyze."
fi