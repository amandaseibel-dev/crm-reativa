/* eslint-disable react-refresh/only-export-components -- harness de preview:
   não há Fast Refresh a preservar aqui, é um arquivo de entrada. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import PainelMeuDia from "/src/components/PainelMeuDia.jsx";
import AvisoRetornoNaHora from "/src/components/AvisoRetornoNaHora.jsx";
import { retornoParaAvisar, somarMinutos } from "/src/utils/alarmeRetorno.js";
import { JANELA_RETORNOS_DIAS, boletosProximosDoVencimento, contarRetornoAutomaticoHoje, retornosAgendados, retornosDoDia } from "/src/utils/painelMeuDia.js";

// Revisão visual do bloco "Meu dia". O componente é puro, então o preview
// passa pelos MESMOS recortes de src/utils/painelMeuDia.js que a carteira usa
// — o que aparece aqui é o que a tela monta. Dados fictícios, volumes nos
// números medidos em produção em 15/10/2026 (um operador: 8 retornos
// agendados, ~405 do prazo automático, ~18 boletos na janela de 5 dias).
const HOJE = "2026-10-15";

const CASOS = [
  { id: "a1", nome_aluno: "Ana Clara Ribeiro", telefone: "(51) 99888-1010", valor_em_aberto: 2480.9, data_retorno: HOJE, retorno_origem: "OPERADOR", hora_retorno: "09:15", responsavel_atual_email: "cobranca06@aelbra.com.br" },
  { id: "a2", nome_aluno: "Bruno Henrique Alves", telefone: "(51) 99777-2020", valor_em_aberto: 860.0, data_retorno: HOJE, retorno_origem: "OPERADOR", hora_retorno: "11:00", responsavel_atual_email: "cobranca06@aelbra.com.br" },
  { id: "a3", nome_aluno: "Carla Souza Lima", telefone: "(51) 99666-3030", valor_em_aberto: 15320.45, data_retorno: HOJE, retorno_origem: "OPERADOR", hora_retorno: "14:30", responsavel_atual_email: "cobranca06@aelbra.com.br" },
  { id: "a4", nome_aluno: "Diego Martins", telefone: "(51) 99555-4040", valor_em_aberto: 1190.3, data_retorno: HOJE, retorno_origem: "OPERADOR", hora_retorno: "16:45", retorno_confirmado_em: "2026-10-15T13:02:00Z", responsavel_atual_email: "cobranca06@aelbra.com.br" },
  { id: "a5", nome_aluno: "Elisa Prado", telefone: "(51) 99444-5050", valor_em_aberto: 3905.12, data_retorno: HOJE, retorno_origem: "OPERADOR", hora_retorno: "15:10", responsavel_atual_email: "cobranca06@aelbra.com.br" },
  // Resto da semana: so aparece quando o operador pede "Semana".
  { id: "a6", nome_aluno: "Felipe Barcellos", telefone: "(51) 99333-6060", valor_em_aberto: 740.0, data_retorno: "2026-10-16", retorno_origem: "OPERADOR", hora_retorno: "10:00", responsavel_atual_email: "cobranca06@aelbra.com.br" },
  { id: "a7", nome_aluno: "Gisele Amaral", telefone: "(51) 99222-7070", valor_em_aberto: 5120.88, data_retorno: "2026-10-16", retorno_origem: "OPERADOR", responsavel_atual_email: "cobranca06@aelbra.com.br" },
  { id: "a8", nome_aluno: "Hugo Tavares", telefone: "(51) 99111-8080", valor_em_aberto: 2310.0, data_retorno: "2026-10-19", retorno_origem: "OPERADOR", hora_retorno: "15:20", responsavel_atual_email: "cobranca06@aelbra.com.br" },
  { id: "a9", nome_aluno: "Iara Menezes", telefone: "(51) 99000-9090", valor_em_aberto: 980.4, data_retorno: "2026-10-21", retorno_origem: "OPERADOR", responsavel_atual_email: "cobranca06@aelbra.com.br" },
  // Prazo automático da tabulação: não entra na lista, só no contador.
  ...Array.from({ length: 405 }, (_, i) => ({ id: `auto${i}`, nome_aluno: `Caso automático ${i}`, data_retorno: HOJE, retorno_origem: "AUTOMATICO" })),
];

const NOMES = ["Fernanda Küster", "Gabriel Nunes", "Helena Dias", "Igor Pacheco", "Joana Beltrão", "Kauê Freitas", "Larissa Antunes", "Marcelo Reis"];
const ACORDOS = NOMES.map((nome, i) => ({ id: `c${i}`, aluno_id: `b${i}`, numero_acordo: 71900 + i, status: "ATIVO", operador_responsavel_email: "cobranca06@aelbra.com.br" }));
const ALUNOS = NOMES.map((nome, i) => ({ id: `b${i}`, nome, nome_aluno: nome }));
const PARCELAS = NOMES.map((nome, i) => ({
  id: `p${i}`,
  acordo_id: `c${i}`,
  numero: (i % 6) + 1,
  status: "A_VENCER",
  vencimento: ["2026-10-15", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-22"][i],
  valor: [312.4, 1890.0, 665.98, 430.15, 2210.77, 980.5, 1575.3, 700.0][i],
  boleto: `5719${String(i).padStart(2, "0")}00${i}3`,
  boleto_confiavel: i !== 4,
}));

const retornos = retornosAgendados(CASOS, HOJE, JANELA_RETORNOS_DIAS);
const boletos = boletosProximosDoVencimento(PARCELAS, {
  acordoById: new Map(ACORDOS.map((a) => [a.id, a])),
  alunoById: new Map(ALUNOS.map((a) => [String(a.id), a])),
  hoje: HOJE,
  // O alerta D-2 do cron marca a linha; não é o que define a lista.
  alertasPorParcela: new Set(["p2"]),
});

function Harness() {
  const [gestao, setGestao] = useState(false);
  // Harness: guarda a escolha do check por id (true = feito, false = desmarcado).
  const [marcados, setMarcados] = useState({});
  // Relógio do harness: a hora é um controle, para dar para ver a caixa de
  // aviso aparecer sem esperar a hora real chegar.
  const [horaAgora, setHoraAgora] = useState("14:35");
  const [silenciados, setSilenciados] = useState(new Map());
  const lista = retornos.map((r) => (r.id in marcados ? { ...r, tratado: marcados[r.id] } : r));
  return (
    <>
      <div style={{ position: "sticky", top: 0, zIndex: 50, display: "flex", gap: 14, alignItems: "center", background: "#0f172a", color: "#fff", padding: "8px 16px", fontSize: 13, fontFamily: "system-ui, sans-serif", flexWrap: "wrap" }}>
        <strong>Preview — bloco “Meu dia”</strong>
        <span>hoje = {HOJE} (fixo)</span>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={gestao} onChange={(e) => setGestao(e.target.checked)} /> visão da gestão (mostra responsável)
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          relógio: <input type="time" value={horaAgora} onChange={(e) => setHoraAgora(e.target.value)} style={{ padding: "2px 4px" }} />
        </label>
        <span style={{ opacity: 0.7 }}>dados fictícios</span>
      </div>
      <AvisoRetornoNaHora
        retorno={retornoParaAvisar(lista, { hoje: HOJE, horaAgora, silenciados })}
        horaAgora={horaAgora}
        onAbrirFicha={(r) => { setSilenciados((m) => new Map(m).set(String(r.id), "")); window.alert(`Abriria a ficha de ${r.nome}`); }}
        onLembrarDepois={(r, min) => setSilenciados((m) => new Map(m).set(String(r.id), somarMinutos(horaAgora, min)))}
        onMarcarFeito={(r) => { setSilenciados((m) => new Map(m).set(String(r.id), "")); setMarcados((x) => ({ ...x, [r.id]: true })); }}
      />
      <div style={{ padding: 20, maxWidth: 1180 }}>
        <PainelMeuDia
          hoje={HOJE}
          retornos={lista}
          retornoAutomaticoHoje={contarRetornoAutomaticoHoje(CASOS.filter((c) => c.data_retorno === HOJE).length, retornosDoDia(retornos, HOJE))}
          boletos={boletos}
          mostrarResponsavel={gestao}
          onAbrirFicha={(item) => window.alert(`Abriria a ficha de ${item.aluno_nome || item.nome}`)}
          onConfirmarRetorno={(id, confirmar) => setMarcados((m) => ({ ...m, [id]: confirmar }))}
          onVerRetornosNaFila={() => window.alert("Abriria a fila filtrada por retorno de hoje")}
        />
      </div>
    </>
  );
}

createRoot(document.getElementById("raiz")).render(<Harness />);
