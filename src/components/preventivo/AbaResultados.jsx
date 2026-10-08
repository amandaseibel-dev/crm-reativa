// Aba Resultados do Preventivo.
//
// A tela responde três perguntas e para por aí: quanto a carteira tinha quando
// começamos, quanto ela caiu de lá para cá, e quanto ainda está em aberto.
// Depois, a linha do tempo por período. O resultado por público e o
// consolidado ficam em "Ver detalhes", porque se sobrepõem e não somam.
//
// A FONTE É O RELATÓRIO IMPORTADO, e só ele. Nada aqui consulta o Prime: a
// comparação é entre fotos do próprio relatório, que é o que a operação tem em
// mãos todo dia. Os objetos de sincronização continuam no banco e nos outros
// módulos — apenas não aparecem nesta aba.
//
// A PALAVRA É "REDUÇÃO DO SALDO APÓS A AÇÃO". Movimento observado entre duas
// fotos. Não é pagamento confirmado: o título sumiu do relatório, e a fonte não
// diz por quê.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { S } from "../../ui/estilosFila";
import PainelPreventivo from "./PainelPreventivo";

export default function AbaResultados({ carteira }) {
  const [painel, setPainel] = useState(null);
  const [intervalos, setIntervalos] = useState(null);
  const [erro, setErro] = useState("");

  // Duas leituras: o painel (resultado por público, que se sobrepõe) e os
  // intervalos entre remessas consecutivas (que não se sobrepõem e somam).
  const buscar = useCallback(() => Promise.all([
    supabase.rpc("preventivo_painel", { p_carteira_id: carteira.id }),
    supabase.rpc("preventivo_intervalos", { p_carteira_id: carteira.id }),
  ]), [carteira.id]);

  useEffect(() => {
    let vivo = true;
    buscar().then(([p, i]) => {
      if (!vivo) return;
      if (p.error || i.error) { setErro((p.error || i.error).message); return; }
      setErro(""); setPainel(p.data); setIntervalos(i.data);
    });
    return () => { vivo = false; };
  }, [buscar]);

  async function definirCusto(acaoId, custo, moeda) {
    const { error } = await supabase.rpc("preventivo_acao_custo_definir", {
      p_acao_id: acaoId, p_custo: custo, p_moeda: moeda ?? null,
    });
    if (error) { setErro(error.message); return false; }
    const [p, i] = await buscar();
    if (p.data) setPainel(p.data);
    if (i.data) setIntervalos(i.data);
    return true;
  }

  if (erro) return <div style={S.erroBox}>{erro}</div>;
  if (!painel) return <p style={S.muted}>Carregando…</p>;

  return <PainelPreventivo dados={painel} intervalos={intervalos} aoMudarCusto={definirCusto} />;
}
