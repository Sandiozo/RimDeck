using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Verse;

namespace RimDeck
{
    // RimDeck's Continue button writes the name of the save to open into RimDeck_Continue.txt in the
    // game's config folder before starting the game. Once the main menu is ready, this opens that save
    // and removes the request. Without a request it does nothing.
    [StaticConstructorOnStartup]
    public static class ContinueOnStartup
    {
        const string RequestFile = "RimDeck_Continue.txt";
        const string OwnId = "rimdeck.continue";

        // A big mod list can take a long time to load, but a request this old is left over from a
        // launch that never got this far.
        static readonly TimeSpan MaxAge = TimeSpan.FromHours(1);

        static ContinueOnStartup()
        {
            string save;
            try
            {
                string path = Path.Combine(GenFilePaths.ConfigFolderPath, RequestFile);
                if (!File.Exists(path)) return;
                bool fresh = DateTime.UtcNow - File.GetLastWriteTimeUtc(path) < MaxAge;
                save = File.ReadAllText(path).Trim();
                File.Delete(path);
                if (!fresh || save.Length == 0) return;
            }
            catch (Exception e)
            {
                Log.Warning("[RimDeck] Could not read the continue request: " + e);
                return;
            }

            // Static constructors run while the game data is still loading, before the menu's window
            // system exists. The game queues "initializing interface" right after data loading, so an
            // event queued now runs once the main menu is ready, like a click in the Load game menu.
            try
            {
                Call(typeof(LongEventHandler), "QueueLongEvent", typeof(Action), (Action)(() => Open(save)), null, false);
            }
            catch (Exception e)
            {
                Log.Warning("[RimDeck] Could not queue opening " + save + ": " + e);
            }
        }

        static void Open(string save)
        {
            if (Current.ProgramState != ProgramState.Entry) return;
            Log.Message("[RimDeck] Continuing " + save);
            string file = GenFilePaths.FilePathForSavedGame(save);
            if (!File.Exists(file))
            {
                Log.Warning("[RimDeck] Save not found: " + file);
                return;
            }
            // This helper is part of the load order but not of saves made before it was added, which
            // the game would report as a different mod list. Without that difference and with a
            // compatible version, the save opens straight away; otherwise the game's own warnings show.
            try
            {
                if (MatchesApartFromHelper(file)) Call(typeof(GameDataSaveLoader), "LoadGame", typeof(string), save);
                else GameDataSaveLoader.CheckVersionAndLoadGame(save);
            }
            catch (Exception e)
            {
                Log.Warning("[RimDeck] Could not open " + save + ": " + e);
            }
        }

        static bool MatchesApartFromHelper(string file)
        {
            try
            {
                Scribe.loader.InitLoadingMetaHeaderOnly(file);
                ScribeMetaHeaderUtility.LoadGameDataHeader(ScribeMetaHeaderUtility.ScribeHeaderMode.Map, false);
                Scribe.loader.FinalizeLoading();
            }
            catch (Exception e)
            {
                Scribe.ForceStop();
                Log.Warning("[RimDeck] Could not read the save header: " + e.Message);
                return false;
            }
            if (!BackCompatibility.IsSaveCompatibleWith(ScribeMetaHeaderUtility.loadedGameVersion) && !VersionsMatch()) return false;
            var saved = Ids(typeof(ScribeMetaHeaderUtility).GetField("loadedModIdsList", BindingFlags.Public | BindingFlags.Static)?.GetValue(null));
            var running = Ids(typeof(LoadedModManager).GetProperty("RunningMods", BindingFlags.Public | BindingFlags.Static)?.GetValue(null));
            return saved.Count > 0 && saved.SequenceEqual(running);
        }

        // The game's collections are read through reflection so one DLL builds for the .NET Framework
        // games (1.4 to 1.6) and still loads on 1.7, whose code is built on .NET 10.
        static List<string> Ids(object list)
        {
            var ids = new List<string>();
            if (list is IEnumerable items)
            {
                foreach (object item in items)
                {
                    string id = item is ModContentPack mod ? mod.PackageId : item as string;
                    if (id != null && id.ToLowerInvariant() != OwnId) ids.Add(id.ToLowerInvariant());
                }
            }
            return ids;
        }

        // Calls a static game method whose first parameter has this type. Some of these methods have
        // overloads taking .NET 10 types on 1.7, which the .NET Framework compiler can't resolve, so
        // they are found by reflection. Parameters after the given ones take their defaults.
        static void Call(Type owner, string name, Type first, params object[] args)
        {
            var method = owner.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Where(m => m.Name == name)
                .Select(m => new { m, p = m.GetParameters() })
                .Where(x => x.p.Length >= args.Length && x.p[0].ParameterType == first)
                // Every given argument must fit its parameter, e.g. QueueLongEvent(Action, string, bool)
                // rather than the scene-loading QueueLongEvent(Action, string, string, bool).
                .Where(x => args.Select((a, i) => a == null ? !x.p[i].ParameterType.IsValueType : x.p[i].ParameterType.IsInstanceOfType(a)).All(ok => ok))
                .Where(x => x.p.Skip(args.Length).All(q => q.HasDefaultValue || !q.ParameterType.IsValueType))
                .OrderBy(x => x.p.Length)
                .First();
            var all = new object[method.p.Length];
            for (int i = 0; i < all.Length; i++) all[i] = i < args.Length ? args[i] : method.p[i].HasDefaultValue ? method.p[i].DefaultValue : null;
            method.m.Invoke(null, all);
        }

        // ScribeMetaHeaderUtility.VersionsMatch is private; treat it as false if it can't be reached.
        static bool VersionsMatch()
        {
            try
            {
                var m = typeof(ScribeMetaHeaderUtility).GetMethod("VersionsMatch", BindingFlags.NonPublic | BindingFlags.Static);
                return m != null && (bool)m.Invoke(null, null);
            }
            catch
            {
                return false;
            }
        }
    }
}
