using System;
using System.IO;
using Verse;

namespace RimDeck
{
    // RimDeck's Continue button writes the name of the save to open into RimDeck_Continue.txt in the
    // game's config folder before starting the game. When loading has finished, this opens that save
    // the same way the Load game menu does, then removes the request. Without a request it does nothing.
    [StaticConstructorOnStartup]
    public static class ContinueOnStartup
    {
        const string RequestFile = "RimDeck_Continue.txt";

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
                Log.Warning("[RimDeck] Could not read the continue request: " + e.Message);
                return;
            }

            LongEventHandler.ExecuteWhenFinished(() =>
            {
                try
                {
                    if (Current.ProgramState != ProgramState.Entry) return;
                    Log.Message("[RimDeck] Continuing " + save);
                    GameDataSaveLoader.CheckVersionAndLoadGame(save);
                }
                catch (Exception e)
                {
                    Log.Warning("[RimDeck] Could not open " + save + ": " + e.Message);
                }
            });
        }
    }
}
