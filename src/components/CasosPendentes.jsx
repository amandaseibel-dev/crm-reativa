import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { S, num } from "./situacoesDaSafraFormato";

// CASOS AINDA PENDENTES — indicador operacional, NÃO é por safra.
//
// Regra da gestão (07/10/2026): é pendente o caso que não tem nenhum pagamento
// registrado OU tem acordo ATIVO com parcela ainda a receber. União das duas,
// sem contar o mesmo caso duas vezes.
//
// Acordo QUITADO não entra: o filtro é `status = 'ATIVO'`.
// Caso com pagamento parcial e acordo ainda aberto entra, pelo segundo ramo.
// Caso sem pagamento e sem acordo entra, pelo primeiro.
//
// Nenhuma conta acontece aqui: a soma e a deduplicação são de
// `casos_pendentes_contar()`. O front desenha e mostra a decomposição, para o
// número não ser uma caixa-preta.
//
// POR QUE A DECOMPOSIÇÃO APARECE: por esta régua, a quase totalidade dos casos
// ativos é pendente — o ramo "sem nenhum pagamento" sozinho pega a maior parte
// da carteira. Um indicador que diz "quase tudo" engana se vier sozinho, então
// as duas parcelas e a sobreposição ficam visíveis ao lado. Os números medidos
// estão na migration, que é onde eles podem ser datados e auditados.

export default function CasosPendentes() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      const { data, error } = await supabase.rpc("casos_pendentes_contar");
      if (!ativo) return;
      if (error) setErro(error.message); else setDados(data || null);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <p style={S.discreto}>Contando os casos pendentes…</p>;
  if (erro) return <p style={S.erro}>Não foi possível contar os casos pendentes: {erro}</p>;
  if (!dados) return null;

  const n = (k) => Number(dados[k] ?? 0);

  return (
    <section style={{ marginTop: 22 }}>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>Casos ainda pendentes</h2>
        <span style={S.apoio}>carteira inteira · não é por safra</span>
      </div>

      <div style={S.cartao}>
        <div style={E.topo}>
          <strong style={E.numero}>{num(n("pendentes"))}</strong>
          <span style={E.unidade}>
            {n("pendentes") === 1 ? "caso" : "casos"} de {num(n("casos_no_escopo"))} ativos
          </span>
        </div>

        <ul style={E.quebra}>
          <li style={E.item}>
            <span style={E.rotulo}>Sem nenhum pagamento registrado</span>
            <span style={E.valor}>{num(n("sem_pagamento"))}</span>
          </li>
          <li style={E.item}>
            <span style={E.rotulo}>Com acordo em aberto, saldo a receber</span>
            <span style={E.valor}>{num(n("com_acordo_aberto"))}</span>
          </li>
          <li style={E.item}>
            <span style={E.rotulo}>Nos dois ao mesmo tempo (contados uma vez)</span>
            <span style={E.valor}>−{num(n("nos_dois"))}</span>
          </li>
        </ul>
      </div>

      <p style={S.rodape}>
        <strong>Pendente é o caso sem nenhum pagamento registrado OU com acordo ativo ainda a receber.</strong>{" "}
        Acordo quitado não entra. Quem está nas duas condições é contado uma vez só — por isso a terceira
        linha desconta, e as três fecham no total.
      </p>
      <p style={S.rodape}>
        Conta <strong>casos ativos</strong>, não alunos e não safra: caso encerrado operacionalmente fica de
        fora, porque chamá-lo de pendente afirmaria trabalho que ninguém vai fazer.
      </p>
    </section>
  );
}

const E = {
  topo: { display: "flex", alignItems: "baseline", gap: 10, paddingBottom: 12,
          borderBottom: "1px solid var(--rv-borda-suave)" },
  numero: { fontSize: 30, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em",
            fontFamily: "'Sora', Inter, sans-serif", fontVariantNumeric: "tabular-nums",
            color: "var(--rv-tinta)" },
  unidade: { fontSize: 13, color: "var(--rv-texto-suave)", fontVariantNumeric: "tabular-nums" },
  quebra: { listStyle: "none", margin: "12px 0 0", padding: 0, display: "flex",
            flexDirection: "column", gap: 6 },
  item: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
          fontSize: 13 },
  rotulo: { color: "var(--rv-texto-suave)", minWidth: 0 },
  valor: { fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
};
