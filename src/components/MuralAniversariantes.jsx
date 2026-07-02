import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function diasAteProximoAniversario(aniversario, hoje) {
  const [, mes, dia] = aniversario.split("-").map(Number);

  let proximo = new Date(hoje.getFullYear(), mes - 1, dia);
  proximo.setHours(0, 0, 0, 0);

  if (proximo.getTime() < hoje.getTime()) {
    proximo = new Date(hoje.getFullYear() + 1, mes - 1, dia);
  }

  const diffMs = proximo.getTime() - hoje.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function formatarDiaMes(aniversario) {
  const [, mes, dia] = aniversario.split("-");
  return `${dia}/${mes}`;
}

export default function MuralAniversariantes() {
  const [aniversariantes, setAniversariantes] = useState([]);

  useEffect(() => {
    async function carregar() {
      const { data } = await supabase
        .from("usuarios")
        .select("nome, apelido, foto_url, aniversario")
        .not("aniversario", "is", null);

      if (!data) return;

      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const mesAtual = hoje.getMonth() + 1;

      const doMes = data
        .filter((usuario) => Number(usuario.aniversario.split("-")[1]) === mesAtual)
        .map((usuario) => ({
          ...usuario,
          diasAte: diasAteProximoAniversario(usuario.aniversario, hoje),
          dia: Number(usuario.aniversario.split("-")[2]),
        }))
        .sort((a, b) => a.dia - b.dia);

      setAniversariantes(doMes);
    }

    carregar();
  }, []);

  if (aniversariantes.length === 0) return null;

  return (
    <div style={estilos.caixa}>
      <strong style={estilos.titulo}>🎂 Aniversariantes do mês</strong>
      <div style={estilos.lista}>
        {aniversariantes.map((pessoa) => (
          <div key={pessoa.nome} style={estilos.item}>
            {pessoa.foto_url ? (
              <img src={pessoa.foto_url} alt={pessoa.nome} style={estilos.foto} />
            ) : (
              <div style={estilos.fotoVazia}>
                {(pessoa.apelido || pessoa.nome || "?").charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div style={estilos.nome}>{pessoa.apelido || pessoa.nome}</div>
              <div style={estilos.data}>
                {pessoa.diasAte === 0
                  ? "🎉 Hoje!"
                  : pessoa.diasAte === 1
                  ? `Amanhã (${formatarDiaMes(pessoa.aniversario)})`
                  : `${formatarDiaMes(pessoa.aniversario)} · em ${pessoa.diasAte} dias`}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const estilos = {
  caixa: {
    padding: "12px 16px",
    marginBottom: 14,
    borderRadius: 10,
    background: "rgba(236, 72, 153, 0.08)",
    border: "1px solid rgba(236, 72, 153, 0.3)",
  },
  titulo: {
    fontSize: 14,
    display: "block",
    marginBottom: 10,
  },
  lista: {
    display: "flex",
    gap: 16,
    flexWrap: "wrap",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  foto: {
    width: 30,
    height: 30,
    borderRadius: "50%",
    objectFit: "cover",
  },
  fotoVazia: {
    width: 30,
    height: 30,
    borderRadius: "50%",
    background: "rgba(148,163,184,0.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
  },
  nome: {
    fontSize: 13,
    fontWeight: 600,
  },
  data: {
    fontSize: 11,
    opacity: 0.75,
  },
};
