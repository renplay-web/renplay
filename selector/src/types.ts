export interface Game {
  slug: string
  title: string
  tags?: string[]
  thumbnail?: string
}

export interface GamesResponse {
  games: Game[]
}
