import Head from 'next/head';
import { useState, useEffect } from 'react';

export default function Home() {
  const [leaderboardData, setLeaderboardData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dataSource, setDataSource] = useState(null);

  useEffect(() => {
    // Page load hote hi API se data fetch karein
    fetch('/api/get-scores')
      .then((res) => {
        if (!res.ok) {
          return res.json().then(data => {
            throw new Error(data.error || `HTTP Error: ${res.status}`);
          }).catch(() => {
            throw new Error(`HTTP Error: ${res.status}`);
          });
        }
        return res.json();
      })
      .then((data) => {
        setLeaderboardData(data.data);
        setDataSource(data.source); // 'cache' ya 'fresh'
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load leaderboard:', err);
        setError(err.message || 'Failed to load data');
        setIsLoading(false);
      });
  }, []);

  return (
    <div className="container">
      <Head>
        <title>Live Study Jam Leaderboard</title>
        <meta name="description" content="Live Google Cloud Study Jam Leaderboard" />
      </Head>

      <main className="main">
        <h1 className="title">
          🚀 Google Cloud Study Jam Leaderboard
        </h1>
        
        {isLoading && <p className="loading">Loading Live Scores... (Please wait)</p>}
        
        {error && <p className="error">Error loading data: {error}</p>}

        {!isLoading && !error && (
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Name</th>
                <th>Skill Badges</th>
                <th>Arcade Game</th>
              </tr>
            </thead>
            <tbody>
              {leaderboardData.map((player, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>{player.name}</td>
                  <td>{player.badgeCount}</td>
                  <td>{player.arcadeComplete === 1 ? '✅' : '❌'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        
        {!isLoading && dataSource && (
          <p className="dataSource">
            Data source: {dataSource} (Updates every 30 minutes)
          </p>
        )}
      </main>
    </div>
  );
}