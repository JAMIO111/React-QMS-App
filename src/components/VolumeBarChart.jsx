import React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// Generate next 6 months for X-axis
const getNextSixMonths = () => {
  const months = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push(
      d.toLocaleString("default", { month: "short", year: "2-digit" })
    );
  }
  return months;
};

// Example data: [{ month: 'Oct 25', volume: 10 }, ...]
const generateChartData = (volumeData = []) => {
  const months = getNextSixMonths();
  return months.map((month, idx) => ({
    month,
    volume: volumeData[idx] ?? Math.floor(Math.random() * 50 + 5), // default random if no data
  }));
};

const VolumeBarChart = ({ volumeData }) => {
  const data = generateChartData(volumeData);

  return (
    <div className="bg-secondary-bg p-2 rounded-3xl shadow-m w-full h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 20, right: 20, left: 0, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: "#4B5563", fontWeight: 500 }} />
          <YAxis tick={{ fill: "#4B5563", fontWeight: 500 }} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1F2937",
              borderRadius: 8,
              border: "none",
            }}
            itemStyle={{ color: "#fff" }}
          />
          <Bar
            dataKey="volume"
            fill="#3B82F6"
            radius={[4, 4, 0, 0]} // rounded top corners
            barSize={30}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default VolumeBarChart;
