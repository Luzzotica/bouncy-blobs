// Optional authentication page for users who want to create persistent sessions
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../contexts/UserContext';

export const Auth: React.FC = () => {
  const navigate = useNavigate();
  const { signUp, signIn } = useUser();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      if (isSignUp) {
        await signUp(email, password, name);
      } else {
        await signIn(email, password);
      }
      // Navigate to home after successful auth
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-black to-indigo-900 flex items-center justify-center p-4">
      <div className="bg-white/10 backdrop-blur-lg rounded-3xl shadow-2xl p-8 md:p-12 max-w-md w-full border border-white/20">
        <div className="text-center mb-6">
          <h1 className="text-5xl font-bold text-white mb-2">Partii</h1>
          <p className="text-white/90 mb-4 text-lg">
            {isSignUp ? 'Create Account' : 'Sign In'}
          </p>
          <p className="text-white/70 text-sm">
            Optional: Create an account to save your game sessions
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignUp && (
            <div>
              <label
                htmlFor="name"
                className="block text-white font-medium mb-2"
              >
                Name
              </label>
              <input
                type="text"
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required={isSignUp}
                className="w-full px-4 py-3 bg-white/10 border-2 border-white/20 rounded-lg text-white placeholder-white/50 focus:outline-none focus:border-purple-400/60 focus:bg-white/15 transition"
                placeholder="Your name"
              />
            </div>
          )}

          <div>
            <label
              htmlFor="email"
              className="block text-white font-medium mb-2"
            >
              Email
            </label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 bg-white/20 border-2 border-white/30 rounded-lg text-white placeholder-white/50 focus:outline-none focus:border-white/50"
              placeholder="your@email.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-white font-medium mb-2"
            >
              Password
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full px-4 py-3 bg-white/20 border-2 border-white/30 rounded-lg text-white placeholder-white/50 focus:outline-none focus:border-white/50"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="bg-red-600/80 backdrop-blur-sm text-white px-4 py-3 rounded-lg text-sm border border-red-500/50">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-white text-purple-600 py-4 rounded-lg font-bold text-lg hover:bg-gray-100 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
          >
            {isLoading
              ? 'Loading...'
              : isSignUp
                ? 'Sign Up'
                : 'Sign In'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError(null);
            }}
            className="text-white/80 hover:text-white text-sm underline"
          >
            {isSignUp
              ? 'Already have an account? Sign in'
              : "Don't have an account? Sign up"}
          </button>
        </div>

        <div className="mt-6 pt-6 border-t border-white/20 text-center">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="text-white/80 hover:text-white text-sm underline"
          >
            Continue without account (anonymous)
          </button>
        </div>
      </div>
    </div>
  );
};

