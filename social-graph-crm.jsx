import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import { User, Users, Phone, Mail, MapPin, Calendar, MessageSquare, Bell, Tag, Plus, Edit2, Trash2, Search, Download, Upload, X, Check, Clock, ChevronRight, Heart, Briefcase, GraduationCap, Coffee } from 'lucide-react';

// Relationship type configurations
const RELATIONSHIP_TYPES = {
  family: { label: 'Family', color: '#ef4444', icon: Heart },
  friend: { label: 'Friend', color: '#22c55e', icon: Users },
  colleague: { label: 'Colleague', color: '#3b82f6', icon: Briefcase },
  acquaintance: { label: 'Acquaintance', color: '#a855f7', icon: Coffee },
  mentor: { label: 'Mentor', color: '#f59e0b', icon: GraduationCap },
};

// Sample starter data (empty)
const INITIAL_DATA = {
  people: [
    { id: '1', name: 'You', relationship: 'self', email: '', phone: '', location: '', birthday: '', notes: 'This is you - the center of your network', tags: [], interactions: [], followUp: null, avatar: '👤' },
  ],
  connections: []
};

// Instagram import data path
const INSTAGRAM_IMPORT_PATH = './instagram-contacts-import.json';

export default function SocialGraphCRM() {
  const [data, setData] = useState(() => {
    const saved = localStorage.getItem('socialGraphCRM');
    return saved ? JSON.parse(saved) : INITIAL_DATA;
  });

  const [isLoading, setIsLoading] = useState(false);
  const [importStatus, setImportStatus] = useState('');

  // Auto-load Instagram data on first run
  useEffect(() => {
    const hasLoadedInstagram = localStorage.getItem('socialGraphCRM_instagramLoaded');
    if (!hasLoadedInstagram && data.people.length <= 1) {
      setIsLoading(true);
      setImportStatus('Loading Instagram contacts...');
      fetch(INSTAGRAM_IMPORT_PATH)
        .then(res => res.json())
        .then(imported => {
          if (imported.people && imported.connections) {
            setData(imported);
            localStorage.setItem('socialGraphCRM_instagramLoaded', 'true');
            setImportStatus(`Loaded ${imported.people.length - 1} Instagram contacts!`);
            setTimeout(() => setImportStatus(''), 3000);
          }
        })
        .catch(err => {
          console.log('Instagram import file not found, starting fresh');
          setImportStatus('');
        })
        .finally(() => setIsLoading(false));
    }
  }, []);

  const [selectedPerson, setSelectedPerson] = useState(null);
  const [editingPerson, setEditingPerson] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRelationship, setFilterRelationship] = useState('all');
  const [activeTab, setActiveTab] = useState('details');
  const [newInteraction, setNewInteraction] = useState({ type: 'call', notes: '', date: new Date().toISOString().split('T')[0] });
  const [connectingFrom, setConnectingFrom] = useState(null);

  const svgRef = useRef(null);
  const simulationRef = useRef(null);

  // Save to localStorage whenever data changes
  useEffect(() => {
    localStorage.setItem('socialGraphCRM', JSON.stringify(data));
  }, [data]);

  // D3 Force Graph
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    svg.selectAll('*').remove();

    const g = svg.append('g');

    // Zoom behavior
    const zoom = d3.zoom()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => g.attr('transform', event.transform));

    svg.call(zoom);

    // Filter data based on search and filter
    const filteredPeople = data.people.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesFilter = filterRelationship === 'all' || p.relationship === filterRelationship || p.relationship === 'self';
      return matchesSearch && matchesFilter;
    });

    const filteredIds = new Set(filteredPeople.map(p => p.id));
    const filteredConnections = data.connections.filter(c =>
      filteredIds.has(c.source) && filteredIds.has(c.target)
    );

    const nodes = filteredPeople.map(p => ({ ...p }));
    const links = filteredConnections.map(c => ({
      source: c.source,
      target: c.target,
      strength: c.strength || 1
    }));

    // Create simulation
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(40));

    simulationRef.current = simulation;

    // Draw links
    const link = g.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#64748b')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', d => d.strength * 2);

    // Draw nodes
    const node = g.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }));

    // Node circles
    node.append('circle')
      .attr('r', d => d.relationship === 'self' ? 30 : 24)
      .attr('fill', d => d.relationship === 'self' ? '#1e293b' : (RELATIONSHIP_TYPES[d.relationship]?.color || '#64748b'))
      .attr('stroke', d => selectedPerson?.id === d.id ? '#fbbf24' : '#fff')
      .attr('stroke-width', d => selectedPerson?.id === d.id ? 4 : 2);

    // Node avatars/initials
    node.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', 'white')
      .attr('font-size', d => d.avatar ? '20px' : '12px')
      .attr('font-weight', 'bold')
      .text(d => d.avatar || d.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase());

    // Node labels
    node.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', 40)
      .attr('fill', '#1e293b')
      .attr('font-size', '12px')
      .attr('font-weight', '500')
      .text(d => d.name.length > 15 ? d.name.substring(0, 15) + '...' : d.name);

    // Follow-up indicator
    node.filter(d => d.followUp && new Date(d.followUp) <= new Date())
      .append('circle')
      .attr('cx', 18)
      .attr('cy', -18)
      .attr('r', 8)
      .attr('fill', '#ef4444');

    node.filter(d => d.followUp && new Date(d.followUp) <= new Date())
      .append('text')
      .attr('x', 18)
      .attr('y', -14)
      .attr('text-anchor', 'middle')
      .attr('fill', 'white')
      .attr('font-size', '10px')
      .text('!');

    // Click handler
    node.on('click', (event, d) => {
      event.stopPropagation();
      if (connectingFrom) {
        if (connectingFrom !== d.id) {
          addConnection(connectingFrom, d.id);
        }
        setConnectingFrom(null);
      } else {
        setSelectedPerson(data.people.find(p => p.id === d.id));
        setActiveTab('details');
      }
    });

    // Update positions
    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // Click on background to deselect
    svg.on('click', () => {
      setSelectedPerson(null);
      setConnectingFrom(null);
    });

    return () => simulation.stop();
  }, [data, searchQuery, filterRelationship, selectedPerson, connectingFrom]);

  // Add new person
  const addPerson = (person) => {
    const newPerson = {
      id: Date.now().toString(),
      ...person,
      interactions: [],
      tags: person.tags || [],
      followUp: person.followUp || null,
      avatar: person.avatar || ''
    };
    setData(prev => ({
      ...prev,
      people: [...prev.people, newPerson]
    }));
    // Auto-connect to "You" if not self
    if (person.relationship !== 'self') {
      const youNode = data.people.find(p => p.relationship === 'self');
      if (youNode) {
        setData(prev => ({
          ...prev,
          people: [...prev.people, newPerson],
          connections: [...prev.connections, { source: youNode.id, target: newPerson.id, strength: 1 }]
        }));
        return;
      }
    }
    setShowAddModal(false);
  };

  // Update person
  const updatePerson = (updated) => {
    setData(prev => ({
      ...prev,
      people: prev.people.map(p => p.id === updated.id ? updated : p)
    }));
    setSelectedPerson(updated);
    setEditingPerson(null);
  };

  // Delete person
  const deletePerson = (id) => {
    if (data.people.find(p => p.id === id)?.relationship === 'self') {
      alert("You can't delete yourself!");
      return;
    }
    setData(prev => ({
      ...prev,
      people: prev.people.filter(p => p.id !== id),
      connections: prev.connections.filter(c => c.source !== id && c.target !== id)
    }));
    setSelectedPerson(null);
  };

  // Add connection
  const addConnection = (sourceId, targetId) => {
    const exists = data.connections.some(c =>
      (c.source === sourceId && c.target === targetId) ||
      (c.source === targetId && c.target === sourceId)
    );
    if (!exists) {
      setData(prev => ({
        ...prev,
        connections: [...prev.connections, { source: sourceId, target: targetId, strength: 1 }]
      }));
    }
  };

  // Remove connection
  const removeConnection = (sourceId, targetId) => {
    setData(prev => ({
      ...prev,
      connections: prev.connections.filter(c =>
        !((c.source === sourceId && c.target === targetId) ||
          (c.source === targetId && c.target === sourceId))
      )
    }));
  };

  // Add interaction
  const addInteraction = () => {
    if (!selectedPerson || !newInteraction.notes) return;
    const updated = {
      ...selectedPerson,
      interactions: [
        { id: Date.now(), ...newInteraction, date: newInteraction.date || new Date().toISOString().split('T')[0] },
        ...selectedPerson.interactions
      ]
    };
    updatePerson(updated);
    setNewInteraction({ type: 'call', notes: '', date: new Date().toISOString().split('T')[0] });
  };

  // Export data
  const exportData = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'social-graph-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Import data
  const importData = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (imported.people && imported.connections) {
          setData(imported);
          setSelectedPerson(null);
        } else {
          alert('Invalid file format');
        }
      } catch (err) {
        alert('Failed to parse file');
      }
    };
    reader.readAsText(file);
  };

  // Get upcoming follow-ups
  const upcomingFollowUps = data.people
    .filter(p => p.followUp)
    .sort((a, b) => new Date(a.followUp) - new Date(b.followUp))
    .slice(0, 5);

  // Get connections for selected person
  const getConnections = (personId) => {
    return data.connections
      .filter(c => c.source === personId || c.target === personId)
      .map(c => {
        const otherId = c.source === personId ? c.target : c.source;
        return data.people.find(p => p.id === otherId);
      })
      .filter(Boolean);
  };

  return (
    <div className="flex h-screen bg-slate-100">
      {/* Left Panel - Graph */}
      <div className="flex-1 flex flex-col">
        {/* Toolbar */}
        <div className="bg-white border-b border-slate-200 p-4 flex items-center gap-4">
          <div className="flex items-center gap-2 flex-1">
            <Search className="w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder="Search people or tags..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 outline-none text-sm"
            />
          </div>
          <select
            value={filterRelationship}
            onChange={(e) => setFilterRelationship(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            <option value="all">All Relationships</option>
            {Object.entries(RELATIONSHIP_TYPES).map(([key, val]) => (
              <option key={key} value={key}>{val.label}</option>
            ))}
          </select>
          <button
            onClick={() => setShowAddModal(true)}
            className="bg-blue-500 text-white px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-blue-600 transition"
          >
            <Plus className="w-4 h-4" /> Add Person
          </button>
          <button
            onClick={exportData}
            className="p-2 hover:bg-slate-100 rounded-lg transition"
            title="Export Data"
          >
            <Download className="w-5 h-5 text-slate-600" />
          </button>
          <label className="p-2 hover:bg-slate-100 rounded-lg transition cursor-pointer" title="Import Data">
            <Upload className="w-5 h-5 text-slate-600" />
            <input type="file" accept=".json" onChange={importData} className="hidden" />
          </label>
        </div>

        {/* Graph */}
        <div className="flex-1 relative">
          <svg ref={svgRef} className="w-full h-full bg-slate-50" />
          {isLoading && (
            <div className="absolute inset-0 bg-slate-50/80 flex items-center justify-center">
              <div className="bg-white rounded-lg p-6 shadow-lg text-center">
                <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-3"></div>
                <p className="text-slate-600">Loading your network...</p>
              </div>
            </div>
          )}
          {importStatus && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-green-100 text-green-800 px-4 py-2 rounded-lg shadow">
              {importStatus}
            </div>
          )}
          {connectingFrom && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-amber-100 text-amber-800 px-4 py-2 rounded-lg shadow">
              Click another person to create a connection, or click background to cancel
            </div>
          )}
          {/* Legend */}
          <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur rounded-lg p-3 shadow">
            <div className="text-xs font-semibold text-slate-600 mb-2">Relationship Types</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(RELATIONSHIP_TYPES).map(([key, val]) => (
                <div key={key} className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: val.color }} />
                  <span className="text-xs text-slate-600">{val.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel - Details */}
      <div className="w-96 bg-white border-l border-slate-200 flex flex-col">
        {selectedPerson ? (
          <>
            {/* Person Header */}
            <div className="p-4 border-b border-slate-200">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center text-white text-xl font-bold"
                    style={{ backgroundColor: selectedPerson.relationship === 'self' ? '#1e293b' : (RELATIONSHIP_TYPES[selectedPerson.relationship]?.color || '#64748b') }}
                  >
                    {selectedPerson.avatar || selectedPerson.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h2 className="font-semibold text-lg">{selectedPerson.name}</h2>
                    <span
                      className="text-sm px-2 py-0.5 rounded-full text-white"
                      style={{ backgroundColor: RELATIONSHIP_TYPES[selectedPerson.relationship]?.color || '#64748b' }}
                    >
                      {RELATIONSHIP_TYPES[selectedPerson.relationship]?.label || selectedPerson.relationship}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1">
                  {selectedPerson.relationship !== 'self' && (
                    <>
                      <button
                        onClick={() => setConnectingFrom(selectedPerson.id)}
                        className="p-2 hover:bg-slate-100 rounded-lg transition"
                        title="Connect to another person"
                      >
                        <Users className="w-4 h-4 text-slate-600" />
                      </button>
                      <button
                        onClick={() => setEditingPerson(selectedPerson)}
                        className="p-2 hover:bg-slate-100 rounded-lg transition"
                        title="Edit"
                      >
                        <Edit2 className="w-4 h-4 text-slate-600" />
                      </button>
                      <button
                        onClick={() => deletePerson(selectedPerson.id)}
                        className="p-2 hover:bg-red-100 rounded-lg transition"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => setSelectedPerson(null)}
                    className="p-2 hover:bg-slate-100 rounded-lg transition"
                  >
                    <X className="w-4 h-4 text-slate-600" />
                  </button>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200">
              {['details', 'interactions', 'connections'].map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-3 text-sm font-medium transition ${
                    activeTab === tab
                      ? 'text-blue-600 border-b-2 border-blue-600'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {activeTab === 'details' && (
                <div className="space-y-4">
                  {selectedPerson.email && (
                    <div className="flex items-center gap-3 text-sm">
                      <Mail className="w-4 h-4 text-slate-400" />
                      <a href={`mailto:${selectedPerson.email}`} className="text-blue-600 hover:underline">{selectedPerson.email}</a>
                    </div>
                  )}
                  {selectedPerson.phone && (
                    <div className="flex items-center gap-3 text-sm">
                      <Phone className="w-4 h-4 text-slate-400" />
                      <a href={`tel:${selectedPerson.phone}`} className="text-blue-600 hover:underline">{selectedPerson.phone}</a>
                    </div>
                  )}
                  {selectedPerson.location && (
                    <div className="flex items-center gap-3 text-sm">
                      <MapPin className="w-4 h-4 text-slate-400" />
                      <span>{selectedPerson.location}</span>
                    </div>
                  )}
                  {selectedPerson.birthday && (
                    <div className="flex items-center gap-3 text-sm">
                      <Calendar className="w-4 h-4 text-slate-400" />
                      <span>{new Date(selectedPerson.birthday).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</span>
                    </div>
                  )}
                  {selectedPerson.followUp && (
                    <div className={`flex items-center gap-3 text-sm ${new Date(selectedPerson.followUp) <= new Date() ? 'text-red-600' : ''}`}>
                      <Bell className="w-4 h-4" />
                      <span>Follow up: {new Date(selectedPerson.followUp).toLocaleDateString()}</span>
                    </div>
                  )}
                  {selectedPerson.tags?.length > 0 && (
                    <div className="flex items-start gap-3 text-sm">
                      <Tag className="w-4 h-4 text-slate-400 mt-1" />
                      <div className="flex flex-wrap gap-1">
                        {selectedPerson.tags.map((tag, i) => (
                          <span key={i} className="bg-slate-100 px-2 py-0.5 rounded text-slate-600">{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedPerson.notes && (
                    <div className="mt-4">
                      <h4 className="text-sm font-medium text-slate-600 mb-2">Notes</h4>
                      <p className="text-sm text-slate-700 bg-slate-50 p-3 rounded-lg">{selectedPerson.notes}</p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'interactions' && (
                <div className="space-y-4">
                  {/* Add Interaction */}
                  <div className="bg-slate-50 p-3 rounded-lg space-y-2">
                    <div className="flex gap-2">
                      <select
                        value={newInteraction.type}
                        onChange={(e) => setNewInteraction(prev => ({ ...prev, type: e.target.value }))}
                        className="border border-slate-200 rounded px-2 py-1 text-sm flex-1"
                      >
                        <option value="call">📞 Call</option>
                        <option value="message">💬 Message</option>
                        <option value="email">📧 Email</option>
                        <option value="meeting">🤝 Meeting</option>
                        <option value="social">🎉 Social</option>
                      </select>
                      <input
                        type="date"
                        value={newInteraction.date}
                        onChange={(e) => setNewInteraction(prev => ({ ...prev, date: e.target.value }))}
                        className="border border-slate-200 rounded px-2 py-1 text-sm"
                      />
                    </div>
                    <textarea
                      value={newInteraction.notes}
                      onChange={(e) => setNewInteraction(prev => ({ ...prev, notes: e.target.value }))}
                      placeholder="What did you talk about?"
                      className="w-full border border-slate-200 rounded px-2 py-1 text-sm resize-none"
                      rows={2}
                    />
                    <button
                      onClick={addInteraction}
                      disabled={!newInteraction.notes}
                      className="w-full bg-blue-500 text-white text-sm py-1.5 rounded hover:bg-blue-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Log Interaction
                    </button>
                  </div>

                  {/* Interaction History */}
                  <div className="space-y-2">
                    {selectedPerson.interactions?.length === 0 ? (
                      <p className="text-sm text-slate-500 text-center py-4">No interactions logged yet</p>
                    ) : (
                      selectedPerson.interactions?.map(int => (
                        <div key={int.id} className="border border-slate-200 rounded-lg p-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">
                              {int.type === 'call' && '📞 Call'}
                              {int.type === 'message' && '💬 Message'}
                              {int.type === 'email' && '📧 Email'}
                              {int.type === 'meeting' && '🤝 Meeting'}
                              {int.type === 'social' && '🎉 Social'}
                            </span>
                            <span className="text-xs text-slate-500">{new Date(int.date).toLocaleDateString()}</span>
                          </div>
                          <p className="text-sm text-slate-600">{int.notes}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'connections' && (
                <div className="space-y-2">
                  {getConnections(selectedPerson.id).length === 0 ? (
                    <p className="text-sm text-slate-500 text-center py-4">No connections yet</p>
                  ) : (
                    getConnections(selectedPerson.id).map(conn => (
                      <div
                        key={conn.id}
                        className="flex items-center justify-between p-2 hover:bg-slate-50 rounded-lg cursor-pointer"
                        onClick={() => setSelectedPerson(conn)}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
                            style={{ backgroundColor: conn.relationship === 'self' ? '#1e293b' : (RELATIONSHIP_TYPES[conn.relationship]?.color || '#64748b') }}
                          >
                            {conn.avatar || conn.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="text-sm font-medium">{conn.name}</div>
                            <div className="text-xs text-slate-500">{RELATIONSHIP_TYPES[conn.relationship]?.label || conn.relationship}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeConnection(selectedPerson.id, conn.id);
                            }}
                            className="p-1 hover:bg-red-100 rounded transition"
                            title="Remove connection"
                          >
                            <X className="w-4 h-4 text-red-500" />
                          </button>
                          <ChevronRight className="w-4 h-4 text-slate-400" />
                        </div>
                      </div>
                    ))
                  )}
                  <button
                    onClick={() => setConnectingFrom(selectedPerson.id)}
                    className="w-full border-2 border-dashed border-slate-200 rounded-lg py-3 text-sm text-slate-500 hover:border-blue-300 hover:text-blue-500 transition"
                  >
                    + Add Connection
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          /* No Selection - Show Overview */
          <div className="flex-1 p-4">
            <h2 className="font-semibold text-lg mb-4">Your Network</h2>
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="bg-blue-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-blue-600">{data.people.length - 1}</div>
                <div className="text-xs text-blue-600">People</div>
              </div>
              <div className="bg-green-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-green-600">{data.connections.length}</div>
                <div className="text-xs text-green-600">Connections</div>
              </div>
            </div>

            {upcomingFollowUps.length > 0 && (
              <div className="mb-6">
                <h3 className="font-medium text-sm text-slate-600 mb-2 flex items-center gap-2">
                  <Bell className="w-4 h-4" /> Follow-ups
                </h3>
                <div className="space-y-2">
                  {upcomingFollowUps.map(person => (
                    <div
                      key={person.id}
                      onClick={() => setSelectedPerson(person)}
                      className={`p-2 rounded-lg cursor-pointer transition flex items-center justify-between ${
                        new Date(person.followUp) <= new Date() ? 'bg-red-50 hover:bg-red-100' : 'bg-slate-50 hover:bg-slate-100'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
                          style={{ backgroundColor: RELATIONSHIP_TYPES[person.relationship]?.color || '#64748b' }}
                        >
                          {person.avatar || person.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}
                        </div>
                        <span className="text-sm font-medium">{person.name}</span>
                      </div>
                      <span className={`text-xs ${new Date(person.followUp) <= new Date() ? 'text-red-600 font-medium' : 'text-slate-500'}`}>
                        {new Date(person.followUp) <= new Date() ? 'Overdue!' : new Date(person.followUp).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="text-center text-slate-400 text-sm mt-8">
              <Users className="w-12 h-12 mx-auto mb-2 opacity-50" />
              Click on a person in the graph<br />to view their details
            </div>
          </div>
        )}
      </div>

      {/* Add/Edit Person Modal */}
      {(showAddModal || editingPerson) && (
        <PersonModal
          person={editingPerson}
          onSave={(person) => {
            if (editingPerson) {
              updatePerson({ ...editingPerson, ...person });
            } else {
              addPerson(person);
            }
            setShowAddModal(false);
            setEditingPerson(null);
          }}
          onClose={() => {
            setShowAddModal(false);
            setEditingPerson(null);
          }}
        />
      )}
    </div>
  );
}

// Person Add/Edit Modal Component
function PersonModal({ person, onSave, onClose }) {
  const [form, setForm] = useState({
    name: person?.name || '',
    relationship: person?.relationship || 'friend',
    email: person?.email || '',
    phone: person?.phone || '',
    location: person?.location || '',
    birthday: person?.birthday || '',
    notes: person?.notes || '',
    tags: person?.tags?.join(', ') || '',
    followUp: person?.followUp || '',
    avatar: person?.avatar || ''
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSave({
      ...form,
      tags: form.tags.split(',').map(t => t.trim()).filter(Boolean)
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-semibold text-lg">{person ? 'Edit Person' : 'Add Person'}</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Avatar (emoji)</label>
            <input
              type="text"
              value={form.avatar}
              onChange={(e) => setForm(prev => ({ ...prev, avatar: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2"
              placeholder="e.g., 👩 or 🧔"
              maxLength={2}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Relationship</label>
            <select
              value={form.relationship}
              onChange={(e) => setForm(prev => ({ ...prev, relationship: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2"
            >
              {Object.entries(RELATIONSHIP_TYPES).map(([key, val]) => (
                <option key={key} value={key}>{val.label}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm(prev => ({ ...prev, email: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm(prev => ({ ...prev, phone: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-2"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Location</label>
              <input
                type="text"
                value={form.location}
                onChange={(e) => setForm(prev => ({ ...prev, location: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-2"
                placeholder="City, Country"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Birthday</label>
              <input
                type="date"
                value={form.birthday}
                onChange={(e) => setForm(prev => ({ ...prev, birthday: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-2"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Follow Up Date</label>
            <input
              type="date"
              value={form.followUp}
              onChange={(e) => setForm(prev => ({ ...prev, followUp: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Tags (comma separated)</label>
            <input
              type="text"
              value={form.tags}
              onChange={(e) => setForm(prev => ({ ...prev, tags: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2"
              placeholder="e.g., hiking, tech, mentor"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm(prev => ({ ...prev, notes: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 resize-none"
              rows={3}
              placeholder="How do you know this person? Any important details?"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-slate-200 text-slate-700 py-2 rounded-lg hover:bg-slate-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 bg-blue-500 text-white py-2 rounded-lg hover:bg-blue-600 transition"
            >
              {person ? 'Save Changes' : 'Add Person'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}