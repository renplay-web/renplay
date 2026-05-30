export interface Game {
  slug: string
  title: string
  author?: string
  description?: string
  tags?: string[]
}

export interface GamesResponse {
  games: Game[]
}
