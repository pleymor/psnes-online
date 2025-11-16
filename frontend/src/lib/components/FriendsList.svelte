<script lang="ts">
  import { onMount } from 'svelte';
  import { socket } from '$lib/api/socket';
  import { goto } from '$app/navigation';

  let friends: any[] = [];
  let friendRequests: any[] = [];
  let showAddFriend = false;
  let friendEmail = '';

  onMount(async () => {
    // Load friends
    const res = await fetch('/api/friends', { credentials: 'include' });
    if (res.ok) {
      friends = await res.json();
    }

    // Load pending requests
    const reqRes = await fetch('/api/friends/requests', { credentials: 'include' });
    if (reqRes.ok) {
      friendRequests = await reqRes.json();
    }

    // Listen for online status updates
    $socket?.on('friends:online', (onlineFriends: any[]) => {
      // Update online status
    });

    $socket?.on('friend:roomCreated', ({ userId, room }: any) => {
      // Show notification that friend created a room
    });
  });

  async function sendFriendRequest() {
    if (!friendEmail) return;

    const res = await fetch('/api/friends/request', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendEmail })
    });

    if (res.ok) {
      friendEmail = '';
      showAddFriend = false;
      alert('Friend request sent!');
    } else {
      const error = await res.json();
      alert(error.error || 'Failed to send request');
    }
  }

  async function acceptRequest(friendshipId: string) {
    await fetch(`/api/friends/accept/${friendshipId}`, {
      method: 'POST',
      credentials: 'include'
    });
    location.reload();
  }

  async function rejectRequest(friendshipId: string) {
    await fetch(`/api/friends/${friendshipId}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    friendRequests = friendRequests.filter(r => r.id !== friendshipId);
  }

  function joinFriend(roomId: string) {
    goto(`/room/${roomId}`);
  }
</script>

<div class="friends-panel">
  <div class="header">
    <h2>Friends</h2>
    <button on:click={() => showAddFriend = !showAddFriend} class="btn-add">
      +
    </button>
  </div>

  {#if showAddFriend}
    <div class="add-friend">
      <input
        type="email"
        bind:value={friendEmail}
        placeholder="Friend's email"
      />
      <button on:click={sendFriendRequest}>Send</button>
    </div>
  {/if}

  {#if friendRequests.length > 0}
    <div class="section">
      <h3>Requests</h3>
      {#each friendRequests as request}
        <div class="request">
          <div class="info">
            <strong>{request.initiator.displayName}</strong>
          </div>
          <div class="actions">
            <button on:click={() => acceptRequest(request.id)} class="btn-accept">✓</button>
            <button on:click={() => rejectRequest(request.id)} class="btn-reject">✗</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="friends-list">
    {#if friends.length === 0}
      <p class="empty">No friends yet</p>
    {:else}
      {#each friends as friend}
        <div class="friend">
          <div class="avatar">
            {#if friend.avatar}
              <img src={friend.avatar} alt={friend.displayName} />
            {:else}
              👤
            {/if}
          </div>
          <div class="info">
            <strong>{friend.displayName}</strong>
            <small>Offline</small>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .friends-panel {
    background: #2a2a2a;
    border-radius: 12px;
    padding: 1.5rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  h2 {
    margin: 0;
    font-size: 1.25rem;
  }

  .btn-add {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 1.25rem;
  }

  .add-friend {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .add-friend input {
    flex: 1;
    padding: 0.5rem;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 6px;
    color: white;
  }

  .add-friend button {
    background: #667eea;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .section {
    margin-bottom: 1rem;
  }

  h3 {
    font-size: 0.875rem;
    color: #888;
    margin: 0 0 0.5rem 0;
  }

  .request {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: #1a1a1a;
    border-radius: 6px;
    margin-bottom: 0.5rem;
  }

  .btn-accept {
    background: #4caf50;
    color: white;
    border: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .btn-reject {
    background: #f44336;
    color: white;
    border: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .friends-list {
    margin-top: 1rem;
  }

  .friend {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background: #1a1a1a;
    border-radius: 6px;
    margin-bottom: 0.5rem;
  }

  .avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: #333;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 1.5rem;
    overflow: hidden;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .info strong {
    display: block;
    font-size: 0.875rem;
  }

  .info small {
    color: #888;
    font-size: 0.75rem;
  }

  .empty {
    text-align: center;
    color: #666;
    padding: 2rem 0;
  }
</style>
