/**
 * POP-SORTE Admin Dashboard - Data Fetcher Module
 * 
 * This module handles fetching and caching of:
 * - Lottery entries data from Google Sheets
 * - Recharge data for validation (POPN1 and POPLUZ platforms)
 * 
 * Data is cached with configurable TTL and refreshed on demand
 * 
 * Dependencies: admin-core.js (AdminCore)
 */

// ============================================
// Data Fetcher Module
// ============================================
window.DataFetcher = (function() {
    'use strict';

    // ============================================
    // Constants - Data Source URLs
    // ============================================
    
    /**
     * Entries sheet: Contains all lottery ticket registrations
     * Source: SORTE-ADMIN.csv
     * Columns: DATA/HORA REGISTRO, PLATFORM, GAME ID, WHATSAPP, NÚMEROS ESCOLHIDOS, DATA SORTEIO, CONCURSO, BILHETE #, STATUS
     */
    const ENTRIES_SHEET_URL = 'https://docs.google.com/spreadsheets/d/14f_ipSqAq8KCP7aFrbIK9Ztbo33BnCw34DSk5ADdPgI/export?format=csv&gid=0&t=1767491207553';
    
    /**
     * Recharge sheets: Contains recharge transactions by platform
     * Each platform has its own sheet for validation
     * Columns: Member ID, Order Number, Region, Currency Type, Merchant, Record Time, Account Change Type, Account Change Category II, Change Amount, Balance After
     */
    const RECHARGE_SHEET_URLS = {
        POPLUZ: 'https://docs.google.com/spreadsheets/d/12GcjRtG23ro4aQ5N-Psh9G0lr0dZ2-qS6C129gGEoQo/export?format=csv&gid=0',
        POPN1: 'https://docs.google.com/spreadsheets/d/1c6gnCngs2wFOvVayd5XpM9D3LOlKUxtSjl7gfszXcMg/export?format=csv&gid=0'
    };

    /**
     * Cache TTL in milliseconds (3 minutes - matches refresh interval)
     */
    const CACHE_TTL = 180 * 1000;

    /**
     * Fetch timeout in milliseconds (15 seconds)
     */
    const FETCH_TIMEOUT = 15 * 1000;

    // ============================================
    // Cache Storage
    // ============================================
    const cache = {
        entries: { data: null, timestamp: 0 },
        recharges: { data: null, timestamp: 0 },
        // Processed data cache - cleared when raw data changes
        validation: { data: null, entriesHash: null },
        winners: { data: null, entriesHash: null, resultsHash: null }
    };

    // Fetch lock to prevent simultaneous requests
    const fetchLock = {
        entries: false,
        recharges: false
    };

    /**
     * Generate simple hash for cache invalidation
     * @param {Object[]} data - Data array to hash
     * @returns {string} Simple hash
     */
    function simpleHash(data) {
        if (!data) return '';
        return `${data.length}-${data[0]?.ticketNumber || data[0]?.contest || ''}-${data[data.length - 1]?.ticketNumber || data[data.length - 1]?.contest || ''}`;
    }

    /**
     * Get cached validation results
     * @returns {Object|null} Cached validation or null
     */
    function getCachedValidation() {
        if (!cache.entries.data || !cache.validation.data) return null;
        const currentHash = simpleHash(cache.entries.data);
        if (cache.validation.entriesHash === currentHash) {
            return cache.validation.data;
        }
        return null;
    }

    /**
     * Set cached validation results
     * @param {Object} data - Validation results
     */
    function setCachedValidation(data) {
        cache.validation = {
            data: data,
            entriesHash: simpleHash(cache.entries.data)
        };
    }

    /**
     * Get cached winner calculations
     * @returns {Object|null} Cached winners or null
     */
    function getCachedWinners() {
        return cache.winners.data;
    }

    /**
     * Set cached winner calculations
     * @param {Object} data - Winner calculation results
     * @param {string} entriesHash - Hash of entries data
     * @param {string} resultsHash - Hash of results data
     */
    function setCachedWinners(data, entriesHash, resultsHash) {
        cache.winners = { data, entriesHash, resultsHash };
    }

    /**
     * Check if winner cache is valid
     * @param {Object[]} entries - Current entries
     * @param {Object[]} results - Current results
     * @returns {boolean} True if cache is valid
     */
    function isWinnersCacheValid(entries, results) {
        if (!cache.winners.data) return false;
        return cache.winners.entriesHash === simpleHash(entries) &&
               cache.winners.resultsHash === simpleHash(results);
    }

    // ============================================
    // Generic Fetch Helper
    // ============================================
    
    /**
     * Fetch CSV data from Google Sheets with timeout and error handling
     * @param {string} url - Sheet export URL
     * @returns {Promise<string>} Raw CSV text
     */
    async function fetchCSV(url) {
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
        
        try {
            const response = await fetch(`${url}&t=${Date.now()}`, {
                cache: 'no-store',
                redirect: 'follow',
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const text = await response.text();

            // Check if we got HTML instead of CSV
            if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
                throw new Error('Sheet not publicly accessible');
            }

            return text;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timed out - please try again');
            }
            throw error;
        }
    }

    // ============================================
    // Entries Data
    // ============================================
    
    /**
     * Parse entry row from CSV
     * @param {string[]} row - CSV row values
     * @returns {Object} Parsed entry object
     */
    function parseEntryRow(row) {
        // CSV Source: SORTE-ADMIN.csv
        // Column 0: DATA/HORA REGISTRO (Entry creation timestamp) - DD/MM/YYYY HH:MM:SS
        // Column 1: (empty)
        // Column 2: (empty)
        // Column 3: PLATFORM
        // Column 4: GAME ID (matches Member ID from recharge CSV)
        // Column 5: WHATSAPP
        // Column 6: NÚMEROS ESCOLHIDOS
        // Column 7: DATA SORTEIO
        // Column 8: CONCURSO
        // Column 9: BILHETE #
        // Column 10: STATUS
        const timestamp = row[0] || ''; // DATA/HORA REGISTRO
        const parsedDate = AdminCore.parseBrazilDateTime(timestamp);
        
        // Parse chosen numbers
        const numbersRaw = row[6] || '';
        const numbers = numbersRaw
            .split(/[,;|\t]/)
            .map(n => parseInt(n.trim(), 10))
            .filter(n => !isNaN(n) && n >= 1 && n <= 80);

        return {
            timestamp: timestamp,
            parsedDate: parsedDate,
            platform: (row[3] || 'POPN1').trim().toUpperCase(),
            gameId: (row[4] || '').trim(),
            whatsapp: (row[5] || '').trim(),
            numbers: numbers,
            drawDate: (row[7] || '').trim(),
            contest: (row[8] || '').trim(),
            ticketNumber: (row[9] || '').trim(),
            status: (row[10] || 'PENDING').trim().toUpperCase()
        };
    }

    /**
     * Fetch all entries from Google Sheet
     * @param {boolean} forceRefresh - Force refresh ignoring cache
     * @returns {Promise<Object[]>} Array of entry objects
     */
    async function fetchEntries(forceRefresh = false) {
        const now = Date.now();
        
        // Return cached data if valid
        if (!forceRefresh && cache.entries.data && (now - cache.entries.timestamp) < CACHE_TTL) {
            return cache.entries.data;
        }

        // Return cached data if fetch is in progress - don't block, just use cache
        if (fetchLock.entries) {
            return cache.entries.data || [];
        }

        fetchLock.entries = true;

        try {
            const csvText = await fetchCSV(ENTRIES_SHEET_URL);
            const lines = csvText.split(/\r?\n/).filter(Boolean);

            if (lines.length <= 1) {
                cache.entries = { data: [], timestamp: now };
                fetchLock.entries = false;
                return [];
            }

            const delimiter = AdminCore.detectDelimiter(lines[0]);
            const entries = [];

            // Parse CSV in batches to avoid blocking UI
            const batchSize = 500;
            const totalLines = lines.length - 1; // Exclude header
            for (let i = 1; i < lines.length; i += batchSize) {
                const batch = lines.slice(i, Math.min(i + batchSize, lines.length));
                
                for (const line of batch) {
                    const row = AdminCore.parseCSVLine(line, delimiter);
                    if (row.length >= 11 && row[4]) { // Must have at least Game ID (column 4)
                        entries.push(parseEntryRow(row));
                    }
                }
                
                // Update loading progress (scaled to 5-25% of total)
                const parseProgress = Math.min(100, Math.round(((i + batchSize - 1) / totalLines) * 100));
                const totalProgress = 5 + Math.round((parseProgress / 100) * 20); // 5% to 25%
                AdminCore.updateLoadingProgress(totalProgress, `Parsing entries... ${parseProgress}%`);
                
                // Yield to UI thread after each batch
                if (i + batchSize < lines.length) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            // Sort by timestamp descending (newest first) - defer if large
            if (entries.length > 1000) {
                // For large datasets, sort in chunks
                entries.sort((a, b) => {
                    const ta = a.parsedDate ? a.parsedDate.getTime() : 0;
                    const tb = b.parsedDate ? b.parsedDate.getTime() : 0;
                    return tb - ta;
                });
            } else {
                entries.sort((a, b) => {
                    const ta = a.parsedDate ? a.parsedDate.getTime() : 0;
                    const tb = b.parsedDate ? b.parsedDate.getTime() : 0;
                    return tb - ta;
                });
            }

            cache.entries = { data: entries, timestamp: now };
            fetchLock.entries = false;
            return entries;

        } catch (error) {
            fetchLock.entries = false;
            // Return cached data if available, even if stale
            if (cache.entries.data) {
                return cache.entries.data;
            }
            throw error;
        }
    }

    // ============================================
    // Recharge Data
    // ============================================
    
    /**
     * Parse recharge row from CSV
     * NEW Sheet Structure (as of Jan 2026):
     *   Column A (0): Member ID - 10 digit game ID
     *   Column B (1): Order Number - unique recharge identifier
     *   Column C (2): Record Time - DD/MM/YYYY HH:MM:SS format
     *   Column D (3): Change Amount - recharge amount (positive number)
     *   Column E (4): Balance After - balance after recharge
     * 
     * @param {string[]} row - CSV row values
     * @returns {Object|null} Parsed recharge object or null if invalid
     */
    function parseRechargeRow(row) {
        // Minimum 4 columns required: Member ID, Order Number, Record Time, Change Amount
        if (!row || row.length < 4) {
            return null;
        }
        
        // Skip header row - check for common header keywords
        const firstCell = (row[0] || '').toLowerCase();
        if (firstCell.includes('member') || firstCell.includes('id') || firstCell === 'a' || firstCell === '') {
            return null;
        }
        
        // NEW CSV Structure (Jan 2026):
        // Column 0 (A): Member ID (gameId) - 10 digits (matches GAME ID from entries CSV)
        // Column 1 (B): Order Number (rechargeId)
        // Column 2 (C): Record Time (recharge timestamp) - DD/MM/YYYY HH:MM:SS
        // Column 3 (D): Change Amount (recharge amount)
        // Column 4 (E): Balance After (optional)
        
        const gameId = row[0] ? row[0].trim() : '';
        const rechargeId = row[1] ? row[1].trim() : '';
        const timestampStr = row[2] ? row[2].trim() : '';
        const amountStr = row[3] ? row[3].trim() : '';
        const balanceAfter = row[4] ? parseFloat(row[4].trim().replace(/,/g, '')) : null;
        
        // Validate game ID (must be 10 digits)
        if (!gameId || !/^\d{10}$/.test(gameId)) {
            // Debug: Log if gameId validation fails (only first few times)
            if (window._rechargeDebugCount === undefined) window._rechargeDebugCount = 0;
            if (window._rechargeDebugCount < 3) {
                console.log(`❌ Recharge row rejected - invalid gameId: "${gameId}" (len=${gameId.length})`);
                window._rechargeDebugCount++;
            }
            return null;
        }
        
        // Parse timestamp from column 2 (C): DD/MM/YYYY HH:MM:SS or D/M/YYYY HH:MM
        // Use AdminCore.parseBrazilDateTime which handles timezone correctly
        let rechargeTime = null;
        if (timestampStr) {
            // Normalize the format: ensure 2-digit day/month and add seconds if missing
            let normalizedTime = timestampStr.trim();
            
            // Handle single-digit day/month: "3/1/2026 13:58" -> "03/01/2026 13:58:00"
            // Also handle cases with or without seconds
            normalizedTime = normalizedTime.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g, (match, d, m, y, h, mm, s) => {
                const day = String(d).padStart(2, '0');
                const month = String(m).padStart(2, '0');
                const hour = String(h).padStart(2, '0');
                const second = s || '00';
                return `${day}/${month}/${y} ${hour}:${mm}:${second}`;
            });
            
            // Use AdminCore.parseBrazilDateTime for proper timezone handling
            // This function handles DD/MM/YYYY HH:MM:SS format correctly
            rechargeTime = AdminCore.parseBrazilDateTime(normalizedTime);
        }
        
        // Validate date
        if (rechargeTime && (isNaN(rechargeTime.getTime()) || !(rechargeTime instanceof Date))) {
            rechargeTime = null;
        }
        
        // Parse amount from column 3 (D)
        let amount = 0;
        if (amountStr) {
            const parsed = parseFloat(amountStr.replace(/,/g, ''));
            if (!isNaN(parsed) && parsed > 0) {
                amount = parsed;
            }
        }
        
        // Skip if missing critical data - log reason
        if (!rechargeId || !rechargeTime || amount === 0) {
            if (window._rechargeDebugCount2 === undefined) window._rechargeDebugCount2 = 0;
            if (window._rechargeDebugCount2 < 3) {
                console.log(`❌ Recharge row rejected - missing data: rechargeId=${!!rechargeId}, rechargeTime=${!!rechargeTime}, amount=${amount}, raw=[${timestampStr}]`);
                window._rechargeDebugCount2++;
            }
            return null;
        }

        return {
            gameId: gameId,
            rechargeId: rechargeId,
            rechargeTime: rechargeTime,
            rechargeTimeRaw: timestampStr,
            amount: amount,
            balanceAfter: balanceAfter,
            status: 'RECHARGE',
            rawRow: row
        };
    }

    /**
     * Parse recharge CSV data for a specific platform
     * @param {string} csvText - Raw CSV text
     * @param {string} platform - Platform name (POPN1 or POPLUZ)
     * @returns {Object[]} Array of recharge objects
     */
    function parseRechargeCSVForPlatform(csvText, platform) {
        const lines = csvText.split(/\r?\n/).filter(Boolean);
        
        console.log(`🔍 [${platform}] CSV has ${lines.length} lines`);
        
        if (lines.length <= 1) {
            console.warn(`⚠️ [${platform}] CSV has no data rows (only header or empty)`);
            return [];
        }

        const delimiter = AdminCore.detectDelimiter(lines[0]);
        console.log(`🔍 [${platform}] Detected delimiter: "${delimiter === ',' ? 'comma' : delimiter}"`);
        console.log(`🔍 [${platform}] Header: ${lines[0].substring(0, 100)}...`);
        
        const recharges = [];
        let skipped = 0;
        let parseErrors = [];

        for (let i = 1; i < lines.length; i++) {
            const row = AdminCore.parseCSVLine(lines[i], delimiter);
            const recharge = parseRechargeRow(row);
            if (recharge) {
                // Add platform info to each recharge for proper validation matching
                recharge.platform = platform;
                recharges.push(recharge);
            } else {
                skipped++;
                // Log first few skipped rows for debugging
                if (parseErrors.length < 3) {
                    parseErrors.push({
                        line: i + 1,
                        row0: row[0],
                        row1: row[1]?.substring(0, 20),
                        row2: row[2],
                        row3: row[3],
                        rowLen: row.length
                    });
                }
            }
        }

        console.log(`✅ [${platform}] Parsed ${recharges.length} recharges, skipped ${skipped} rows`);
        if (parseErrors.length > 0) {
            console.log(`🔍 [${platform}] Sample skipped rows:`, parseErrors);
        }
        if (recharges.length > 0) {
            console.log(`🔍 [${platform}] First recharge:`, {
                gameId: recharges[0].gameId,
                amount: recharges[0].amount,
                time: recharges[0].rechargeTimeRaw
            });
        }

        return recharges;
    }

    /**
     * Fetch all recharge data from both POPN1 and POPLUZ Google Sheets
     * @param {boolean} forceRefresh - Force refresh ignoring cache
     * @returns {Promise<Object[]>} Array of recharge objects from all platforms
     */
    async function fetchRecharges(forceRefresh = false) {
        const now = Date.now();
        
        // Return cached data if valid
        if (!forceRefresh && cache.recharges.data && (now - cache.recharges.timestamp) < CACHE_TTL) {
            return cache.recharges.data;
        }

        // Return cached data if fetch is in progress - don't block, just use cache
        if (fetchLock.recharges) {
            return cache.recharges.data || [];
        }

        fetchLock.recharges = true;

        try {
            // Fetch from both platforms in parallel
            const allRecharges = [];
            const fetchPromises = [];

            for (const [platform, url] of Object.entries(RECHARGE_SHEET_URLS)) {
                console.log(`🌐 [${platform}] Fetching from: ${url.substring(0, 80)}...`);
                fetchPromises.push(
                    fetchCSV(url)
                        .then(csvText => {
                            console.log(`📄 [${platform}] Received ${csvText.length} characters of CSV data`);
                            if (csvText.length < 100) {
                                console.warn(`⚠️ [${platform}] CSV seems too short: "${csvText.substring(0, 200)}"`);
                            }
                            const platformRecharges = parseRechargeCSVForPlatform(csvText, platform);
                            console.log(`📥 [${platform}] Parsed ${platformRecharges.length} recharges`);
                            return platformRecharges;
                        })
                        .catch(error => {
                            console.error(`❌ [${platform}] FETCH ERROR:`, error.message || error);
                            console.error(`❌ [${platform}] URL was: ${url}`);
                            return []; // Return empty array on error to not break the whole fetch
                        })
                );
            }

            // Wait for all platform fetches to complete
            const results = await Promise.all(fetchPromises);
            
            // Merge all platform recharges
            for (const platformRecharges of results) {
                allRecharges.push(...platformRecharges);
            }

            console.log(`📊 Total recharges loaded: ${allRecharges.length} (POPN1: ${allRecharges.filter(r => r.platform === 'POPN1').length}, POPLUZ: ${allRecharges.filter(r => r.platform === 'POPLUZ').length})`);

            // Sort by timestamp descending
            allRecharges.sort((a, b) => {
                const ta = a.rechargeTime ? a.rechargeTime.getTime() : 0;
                const tb = b.rechargeTime ? b.rechargeTime.getTime() : 0;
                return tb - ta;
            });

            cache.recharges = { data: allRecharges, timestamp: now };
            fetchLock.recharges = false;
            return allRecharges;

        } catch (error) {
            fetchLock.recharges = false;
            if (cache.recharges.data) {
                return cache.recharges.data;
            }
            throw error;
        }
    }

    // ============================================
    // Aggregation Helpers
    // ============================================
    
    /**
     * Get unique game IDs from entries
     * @param {Object[]} entries - Entry objects
     * @returns {Set<string>} Set of unique game IDs
     */
    function getUniqueGameIds(entries) {
        return new Set(entries.map(e => e.gameId).filter(Boolean));
    }

    /**
     * Get unique game IDs from recharges
     * @param {Object[]} recharges - Recharge objects
     * @returns {Set<string>} Set of unique game IDs
     */
    function getUniqueRechargerIds(recharges) {
        return new Set(recharges.map(r => r.gameId).filter(Boolean));
    }

    /**
     * Get entries grouped by date (YYYY-MM-DD)
     * @param {Object[]} entries - Entry objects
     * @returns {Object} Object with date keys and entry arrays
     */
    function groupEntriesByDate(entries) {
        const grouped = {};
        
        entries.forEach(entry => {
            // Validate date before formatting
            if (entry.parsedDate && entry.parsedDate instanceof Date && !isNaN(entry.parsedDate.getTime())) {
                const dateKey = AdminCore.getBrazilDateString(entry.parsedDate);
                if (dateKey) {  // Only group if we got a valid date string
                    if (!grouped[dateKey]) {
                        grouped[dateKey] = [];
                    }
                    grouped[dateKey].push(entry);
                }
            }
        });
        
        return grouped;
    }

    /**
     * Get recharges grouped by date (YYYY-MM-DD)
     * @param {Object[]} recharges - Recharge objects
     * @returns {Object} Object with date keys and recharge arrays
     */
    function groupRechargesByDate(recharges) {
        const grouped = {};
        
        recharges.forEach(recharge => {
            // Validate date before formatting
            if (recharge.rechargeTime && recharge.rechargeTime instanceof Date && !isNaN(recharge.rechargeTime.getTime())) {
                const dateKey = AdminCore.getBrazilDateString(recharge.rechargeTime);
                if (dateKey) {  // Only group if we got a valid date string
                    if (!grouped[dateKey]) {
                        grouped[dateKey] = [];
                    }
                    grouped[dateKey].push(recharge);
                }
            }
        });
        
        return grouped;
    }

    /**
     * Get entries grouped by contest
     * @param {Object[]} entries - Entry objects
     * @returns {Object} Object with contest keys and entry arrays
     */
    function groupEntriesByContest(entries) {
        const grouped = {};
        
        entries.forEach(entry => {
            const contest = entry.contest || 'Unknown';
            if (!grouped[contest]) {
                grouped[contest] = [];
            }
            grouped[contest].push(entry);
        });
        
        return grouped;
    }

    /**
     * Get entries for last N days
     * @param {Object[]} entries - Entry objects
     * @param {number} days - Number of days
     * @returns {Object[]} Filtered entries
     */
    function getEntriesLastNDays(entries, days = 7) {
        const now = AdminCore.getBrazilTime();
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - days);
        cutoff.setHours(0, 0, 0, 0);
        
        return entries.filter(entry => 
            entry.parsedDate && entry.parsedDate >= cutoff
        );
    }

    /**
     * Get recharges for last N days
     * @param {Object[]} recharges - Recharge objects
     * @param {number} days - Number of days
     * @returns {Object[]} Filtered recharges
     */
    function getRechargesLastNDays(recharges, days = 7) {
        const now = AdminCore.getBrazilTime();
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - days);
        cutoff.setHours(0, 0, 0, 0);
        
        return recharges.filter(recharge => 
            recharge.rechargeTime && recharge.rechargeTime >= cutoff
        );
    }

    /**
     * Get top entrants by entry count
     * @param {Object[]} entries - Entry objects
     * @param {number} limit - Max number to return
     * @returns {Object[]} Array of {gameId, whatsapp, count, entries}
     */
    function getTopEntrants(entries, limit = 10) {
        const counts = {};
        
        entries.forEach(entry => {
            if (!entry.gameId) return;
            
            if (!counts[entry.gameId]) {
                counts[entry.gameId] = {
                    gameId: entry.gameId,
                    whatsapp: entry.whatsapp,
                    count: 0,
                    entries: []
                };
            }
            counts[entry.gameId].count++;
            counts[entry.gameId].entries.push(entry);
        });
        
        return Object.values(counts)
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }

    // ============================================
    // Cache Management
    // ============================================
    
    /**
     * Clear all cached data
     */
    function clearCache() {
        cache.entries = { data: null, timestamp: 0 };
        cache.recharges = { data: null, timestamp: 0 };
        cache.validation = { data: null, entriesHash: null };
        cache.winners = { data: null, entriesHash: null, resultsHash: null };
    }

    /**
     * Get cache status
     * @returns {Object} Cache status info
     */
    function getCacheStatus() {
        const now = Date.now();
        return {
            entries: {
                loaded: cache.entries.data !== null,
                count: cache.entries.data ? cache.entries.data.length : 0,
                age: cache.entries.timestamp ? now - cache.entries.timestamp : null,
                stale: cache.entries.timestamp ? (now - cache.entries.timestamp) > CACHE_TTL : true
            },
            recharges: {
                loaded: cache.recharges.data !== null,
                count: cache.recharges.data ? cache.recharges.data.length : 0,
                age: cache.recharges.timestamp ? now - cache.recharges.timestamp : null,
                stale: cache.recharges.timestamp ? (now - cache.recharges.timestamp) > CACHE_TTL : true
            }
        };
    }

    // ============================================
    // Refresh Handler
    // ============================================
    
    /**
     * Refresh all data (called by auto-refresh)
     */
    async function refreshAll() {
        await Promise.all([
            fetchEntries(true),
            fetchRecharges(true)
        ]);
    }

    // Listen for refresh events
    if (typeof AdminCore !== 'undefined') {
        AdminCore.on('refresh', refreshAll);
    }

    // ============================================
    // Public API
    // ============================================
    return {
        // Fetch methods
        fetchEntries,
        fetchRecharges,
        refreshAll,
        
        // Aggregation helpers
        getUniqueGameIds,
        getUniqueRechargerIds,
        groupEntriesByDate,
        groupRechargesByDate,
        groupEntriesByContest,
        getEntriesLastNDays,
        getRechargesLastNDays,
        getTopEntrants,
        
        // Cache management
        clearCache,
        getCacheStatus,
        
        // Processed data cache
        getCachedValidation,
        setCachedValidation,
        getCachedWinners,
        setCachedWinners,
        isWinnersCacheValid,
        simpleHash,
        
        // Constants
        CACHE_TTL
    };
})();

