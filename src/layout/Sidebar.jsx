import { useState } from "react";

export default function Sidebar({ active, setActive }) {
  const menu = [
    { name: "Dashboard", icon: "🏠" },
    { name: "Aluno", icon: "👤" },
    { name: "CRM", icon: "🔎" },
    { name: "Importações", icon: "📥" },
    { name: "Financeiro", icon: "💰" },
    { name: "Operação", icon: "📞" },
    { name: "Relatórios", icon: "📊" },
    { name: "Configurações", icon: "⚙️" },
  ];

  return (
    <div
      style={{
        width: 240,
        height: "100vh",
        background: "#0b001a",
        borderRight: "1px solid #2e1065",
        padding: 20,
        color: "#fff",
      }}
    >
      <h2 style={{ color: "#a855f7", marginBottom: 20 }}>
        ReATIVA
      </h2>

      {menu.map((item) => {
        const isActive = active === item.name;

        return (
          <div
            key={item.name}
            onClick={() => setActive(item.name)}
            style={{
              padding: "10px 12px",
              marginBottom: 8,
              borderRadius: 10,
              cursor: "pointer",
              background: isActive ? "#7c3aed" : "transparent",
              color: isActive ? "#fff" : "#c4b5fd",
              display: "flex",
              gap: 10,
              alignItems: "center",
              transition: "0.2s",
            }}
          >
            <span>{item.icon}</span>
            <span>{item.name}</span>
          </div>
        );
      })}
    </div>
  );
}
