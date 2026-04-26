/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SteamProfile {
  steamid: string;
  communityvisibilitystate: number;
  profilestate: number;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarmedium: string;
  avatarfull: string;
  avatarhash: string;
  lastlogoff: number;
  personastate: number;
  primaryclanid?: string;
  timecreated?: number;
  personastateflags: number;
  loccountrycode?: string;
}

export interface SteamGame {
  appid: number;
  name: string;
  playtime_forever: number;
  img_icon_url?: string;
  logo_url?: string;
  playtime_windows_forever?: number;
  playtime_mac_forever?: number;
  playtime_linux_forever?: number;
  rtime_last_played?: number;
  playtime_disconnected?: number;
}

export interface SteamOwnedGamesResponse {
  game_count: number;
  games: SteamGame[];
}

export enum ProfileState {
  Offline = 0,
  Online = 1,
  Busy = 2,
  Away = 3,
  Snooze = 4,
  LookingToTrade = 5,
  LookingToPlay = 6,
}
