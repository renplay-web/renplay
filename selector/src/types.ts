export interface Game {
  slug: string
  title: string
  tags?: string[]
  thumbnail?: string
  walkthrough?: string
}

export interface GamesResponse {
  games: Game[]
}
